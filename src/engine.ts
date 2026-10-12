// The front door: Inbound → Outbound[]. Knows nothing about iMessage or the terminal.
// A turn is: (1) is this an answer to a pending offer? the state machine decides; (2) otherwise the agent replies,
// with bring_in among its tools; (3) a hand-off the student consented to in that same turn (they named the agent,
// or already have it) goes out now. Every reply passes G1 before it is sent or remembered.
import type { AddResult, AddUser, Inbound, Outbound, Persona, PersonaId, ToolCtx, UserProfile } from "./types.ts";
import type { LlmClient } from "./llm/client.ts";
import type { Store } from "./store.ts";
import { respond, type Setting } from "./agent.ts";
import { escapeRe, govern } from "./governance.ts";
import { answersOffer, consentFromText, getPending, OFFER_TTL_MS, PLAIN_YES, setPending, type Pending } from "./handoff/state.ts";
import { recruitTool } from "./handoff/tool.ts";
import { ackText, runRecruit } from "./handoff/run.ts";

export interface EngineDeps {
  personas: Map<PersonaId, Persona>;
  store: Store;
  llm: LlmClient;
  names: Record<PersonaId, string>;
  product: string;
  now?: () => number;
  log?: (msg: string) => void;
  addUser?: AddUser; // put a student on an agent's own number; unset = nothing to add anyone to
  // Send texts outside the turn (a recruited agent's texts, as soon as each is ready). Unset: they come back with it.
  deliver?: (outs: Outbound[]) => Promise<void>;
  ownNumber?: (id: PersonaId) => boolean; // does this agent text from a number of its own? default: no
  projectFor?: (id: PersonaId) => string; // where that number lives (UserProfile.poolLines key); default: the id
  hello?: (id: PersonaId, phone: string) => Outbound[]; // a brought-in agent's hello + card; default: Persona.hello
}

export class Engine {
  readonly d: EngineDeps;
  private readonly adds = new Map<string, Promise<AddResult>>(); // "<phone>|<agent>" → add in flight
  private readonly sending = new Set<Promise<void>>(); // deliveries in flight (EngineDeps.deliver)
  private readonly now: () => number;
  readonly log: (msg: string) => void;
  readonly ownNumber: (id: PersonaId) => boolean;
  readonly projectFor: (id: PersonaId) => string;

  constructor(deps: EngineDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.log(`[core] ${m}`));
    this.ownNumber = deps.ownNumber ?? (() => false);
    this.projectFor = deps.projectFor ?? ((id) => id);
  }

  // Texts handed to EngineDeps.deliver outside the turn: tracked so a caller can wait for them before exiting.
  track(p: Promise<void>): void {
    this.sending.add(p);
    void p.finally(() => this.sending.delete(p));
  }

  // Resolves once every delivery in flight (and any started meanwhile) has settled.
  async settled(): Promise<void> {
    while (this.sending.size) await Promise.allSettled([...this.sending]);
  }

  // The engine's clock (tests and the demo move it).
  time(): number {
    return this.now();
  }

  async handle(ev: Inbound): Promise<Outbound[]> {
    const user = this.d.store.user(ev.sender);
    const persona = this.pick(user, ev);
    const answered = await this.answerOffer(ev, persona, user);
    if (answered) return answered;
    const turnStart = this.now();
    const text = await this.reply(persona, user, ev.text ?? "", "dm");
    if (user.lastAgent !== persona) this.d.store.saveUser({ ...this.d.store.user(user.phone), lastAgent: persona });
    // Texts that arrive without a known line come in on a number several agents share; prefix the speaker's name then.
    const shared = !ev.lineKnown && (user.agents?.length ?? 0) > 1;
    const reply: Outbound = { persona, handle: ev.handle, text: shared ? `${this.d.names[persona]}: ${text}` : text };
    // bring_in this turn for an agent they named or already have: no question, it texts now.
    const made = getPending(this.d.store, user.phone);
    const ready = made && made.from === persona && made.offeredAt >= turnStart ? made.agents.filter((a) => a.consent !== "pending") : [];
    if (!made || !ready.length) return [reply];
    setPending(this.d.store, user.phone, { ...made, agents: made.agents.filter((a) => a.consent === "pending") });
    return [reply, ...(await runRecruit(this, user.phone, { ...made, agents: ready })).out];
  }

  // Who answers. Their own line → that agent; on a shared number, whoever they talked to last, else their first.
  private pick(user: UserProfile, ev: Inbound): PersonaId {
    if (ev.lineKnown) return ev.persona;
    const mine = (user.agents ?? []).filter((id) => this.d.personas.has(id));
    return user.lastAgent && mine.includes(user.lastAgent) ? user.lastAgent : (mine[0] ?? ev.persona);
  }

  // An offer to bring another agent in, answered in the conversation it was made in (src/handoff/state.ts).
  // undefined: this text isn't an answer; it goes to the agent as a normal message.
  private async answerOffer(ev: Inbound, persona: PersonaId, user: UserProfile): Promise<Outbound[] | undefined> {
    const offer = getPending(this.d.store, user.phone);
    if (!offer || !answersOffer(offer, persona, ev.lineKnown, this.now())) return undefined;
    const waiting = offer.agents.filter((a) => a.consent === "pending");
    const answer = consentFromText(ev.text ?? "");
    // In another hand-off agent's thread (they replied where the last text landed) only a plain yes accepts, and not
    // when that agent just asked its own question. Anything else is for that agent, and the offer stays open.
    const side = Boolean(ev.lineKnown) && offer.from !== persona;
    const ownQuestion = side && /\?|your call/i.test(this.d.store.history(persona, user.phone).at(-1)?.text ?? "");
    const accepts = !side || (answer === "yes" && PLAIN_YES.test(ev.text ?? "") && !ownQuestion);
    if (!waiting.length || !accepts) return undefined;
    setPending(this.d.store, user.phone, { ...offer, agents: offer.agents.filter((a) => a.consent !== "pending") }); // one shot
    if (answer === "no") return [{ persona, handle: ev.handle, text: "no worries" }];
    if (answer !== "yes") return undefined;
    const r = await runRecruit(this, user.phone, { ...offer, agents: waiting });
    const ids = waiting.map((a) => a.id);
    return [{ persona, handle: ev.handle, text: ackText(this.d.names, ids, r.viaFrom, this.ownNumber, side ? offer.from : undefined) }, ...r.out];
  }

  // Does bringing this agent in mean adding them to its own number first?
  needsAdd(id: PersonaId, user: UserProfile): boolean {
    return Boolean(this.d.addUser && this.ownNumber(id) && !user.poolLines?.[this.projectFor(id)]);
  }

  // The add for this person and agent: the one already in flight (started when it was offered), or a new one.
  addFor(id: PersonaId, user: UserProfile): Promise<AddResult> {
    const key = `${user.phone}|${id}`;
    let p = this.adds.get(key);
    if (!p) {
      p = this.d.addUser!(user.phone, user.name ?? "", id).catch((err): AddResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      this.adds.set(key, p);
    }
    // A successful add stays here, so the "yes" that follows the offer reuses it instead of adding again;
    // a failed one is dropped so the next offer can retry.
    void p.then((r) => {
      if (!r.ok) this.adds.delete(key);
    });
    return p;
  }

  // A brought-in agent's first texts: its hello, then its contact card with the number THIS person texts.
  hello(id: PersonaId, phone: string): Outbound[] {
    if (this.d.hello) return this.d.hello(id, phone);
    const name = this.d.names[id];
    const line = this.ownNumber(id) ? this.d.store.user(phone).poolLines?.[this.projectFor(id)] : undefined;
    return [
      { persona: id, handle: `dm:${phone}`, text: this.d.personas.get(id)?.hello ?? `hey, it's ${name.toLowerCase()}` },
      { persona: id, handle: `dm:${phone}`, text: "", card: { name: `${name} ${this.d.product}`, ...(line ? { phone: line } : {}) } },
    ];
  }

  ctx(id: PersonaId, user: UserProfile): ToolCtx {
    return { user, now: new Date(this.now()), log: (m) => this.log(`${id}: ${m}`) };
  }

  async reply(id: PersonaId, user: UserProfile, text: string, setting: Setting): Promise<string> {
    try {
      return await this.replyOrThrow(id, user, text, setting);
    } catch (err) {
      this.log(`ERROR ${id} reply failed: ${err instanceof Error ? err.message : err}`);
      return "one sec, my brain glitched. try that again?";
    }
  }

  // hand: in a hand-off answer ("recruit"), the agents that hand-off dispatched (a claim about one of them is true)
  // and what the student said to start it.
  async replyOrThrow(id: PersonaId, user: UserProfile, text: string, setting: Setting, hand?: { party: PersonaId[]; said: string }): Promise<string> {
    const base = this.d.personas.get(id)!;
    // In their own DMs every agent can bring another one in.
    const persona =
      setting === "dm"
        ? {
            ...base,
            tools: [
              ...base.tools,
              recruitTool({
                store: this.d.store,
                names: this.d.names,
                from: id,
                text,
                now: this.now,
                needsAdd: (a, u) => this.needsAdd(a, u),
                startAdd: (a, u) => void this.addFor(a, u),
              }),
            ],
          }
        : base;
    const started = this.now();
    const raw = await respond({
      persona,
      ctx: this.ctx(id, user),
      llm: this.d.llm,
      history: this.d.store.history(id, user.phone),
      text,
      setting,
      product: this.d.product,
      names: this.d.names,
    });
    const said = setting === "recruit" ? [] : [{ role: "user" as const, text }];
    // G1 (src/governance.ts): a text may only say another agent is texting if that hand-off went out this turn
    // (bring_in exists only in DM turns). Checked before history, so a false claim isn't re-read next turn.
    const made = getPending(this.d.store, user.phone);
    const dispatched =
      setting === "recruit"
        ? (hand?.party ?? [])
        : made && made.from === id && made.offeredAt >= started ? made.agents.filter((a) => a.consent !== "pending").map((a) => a.id) : [];
    const v = govern(raw, { persona: id, dispatched }, this.d.names);
    for (const h of v.hits) this.log(`${id}: governed ${h.rule}: ${h.detail}`);
    // The rewrite asks "want dean to jump in?": make that a real offer from the agent that said it, so a plain "yes"
    // in its thread goes through answerOffer like any other (same TTL, same one shot). Another agent's live offer
    // is never overwritten: that one stands, and this rewrite is only a question.
    const offered = [...new Set(v.hits.map((h) => h.agent))];
    if (offered.length) {
      const cur = getPending(this.d.store, user.phone);
      const live = cur && cur.agents.some((a) => a.consent === "pending") && this.now() - cur.offeredAt < OFFER_TTL_MS;
      const mine = cur && cur.from === id && cur.offeredAt >= started;
      if (live && cur.from !== id) {
        this.log(`${id}: G1 offer not recorded: ${cur.from}'s offer is still open`);
      } else {
        const ask = (setting === "recruit" ? (hand?.said ?? text) : text).slice(0, 200);
        const base: Pending = mine ? cur : { from: id, text: ask, offeredAt: this.now(), agents: [] };
        const keep = base.agents.filter((a) => !offered.includes(a.id));
        setPending(this.d.store, user.phone, {
          ...base,
          agents: [...keep, ...offered.map((a) => ({ id: a, ask, consent: "pending" as const }))],
          party: [...new Set([...(base.party ?? [id]), ...offered])],
        });
      }
    }
    // The engine adds the "Penny: " tag itself; a model-written one would stack or teach the habit via history.
    const out = v.text.replace(new RegExp(`^\\s*${escapeRe(this.d.names[id])}\\s*:\\s*`, "i"), "");
    this.d.store.pushHistory(id, user.phone, ...said, { role: "model", text: out });
    return out;
  }
}
