// Shared fixtures for the hand-off tests: three agents, one student, a clock the test moves, and a spy model.
// The spy answers by role: every hand-off brief gets "<Name> answer", a tool result gets "<Name> reply" (Sunny's
// asks the hand-off question), and Sunny calls bring_in on a beach plan or when the student names Penny.
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { loadPersonas } from "../personas/index.ts";
import type { LlmClient, LlmMessage, LlmStep } from "../src/llm/client.ts";
import type { AddResult, Inbound, PersonaId, UserProfile } from "../src/types.ts";

export const PHONE = "+19195550100";
export const T0 = Date.UTC(2026, 9, 11, 6, 0);
export const NAMES: Record<PersonaId, string> = { academic: "Dean", financial: "Penny", social: "Sunny" };
export const LINES: Record<PersonaId, string> = { social: "+19195550101", financial: "+19195550102", academic: "+19195550103" };
export const HANDLE: Record<PersonaId, string> = { social: "sunny-space", financial: "penny-space", academic: "dean-space" };
export const BEACH = "I'm going on the beach trip Saturday";

export type Chat = LlmClient["chat"];
export type Req = Parameters<Chat>[0];
export const me = (req: Req) => /You are (\w+),/.exec(req.system)?.[1] ?? "?";
export const lastUser = (req: Req) => {
  const last = req.messages.at(-1) as LlmMessage;
  return last.role === "user" ? last.text : undefined;
};

export const spy: LlmClient = {
  name: "spy",
  json: async () => "{}",
  chat: async (req) => {
    const who = me(req);
    const last = req.messages.at(-1) as LlmMessage;
    if (last.role === "tool") return { text: who === "Sunny" ? "you're in! want Penny to jump in on this?" : `${who} reply` };
    const text = lastUser(req) ?? "";
    if (text.startsWith("[handoff")) return { text: `${who} answer` };
    if (who === "Sunny" && /beach/i.test(text)) return { toolCalls: [{ name: "bring_in", args: { agent: "financial", ask: "price the beach trip" } }] };
    if (who === "Sunny" && /ask penny/i.test(text)) return { toolCalls: [{ name: "bring_in", args: { agent: "financial", ask: "can they afford boba", asked: true } }] };
    return { text: `${who} reply` };
  },
};

// A spy with one override: `extra` answers first when it returns a step.
export const withSpy = (extra: (req: Req) => LlmStep | undefined | Promise<LlmStep | undefined>): LlmClient => ({
  ...spy,
  chat: async (req) => (await extra(req)) ?? spy.chat(req),
});

export const bringIn = (...asks: [PersonaId, string, boolean?][]): LlmStep => ({
  toolCalls: asks.map(([agent, ask, asked]) => ({ name: "bring_in", args: { agent, ask, ...(asked ? { asked } : {}) } })),
});

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export interface SetupOpts {
  llm?: LlmClient;
  user?: Partial<UserProfile>;
  addResults?: Partial<Record<PersonaId, AddResult>>;
  // Hold every add until the test releases it (the provider CLI took seconds live).
  addGate?: Promise<void>;
  ownNumbers?: boolean; // default true: each agent has its own number
}

export function setup(o: SetupOpts = {}) {
  const store = new Store(null);
  const clock = { t: T0, advance: (ms: number) => void (clock.t += ms) };
  const adds: PersonaId[] = [];
  const own = o.ownNumbers ?? true;
  const engine = new Engine({
    personas: loadPersonas(),
    store,
    llm: o.llm ?? spy,
    names: NAMES,
    product: "Suitemates",
    now: () => clock.t,
    log: () => {},
    ownNumber: () => own,
    projectFor: (id) => `p-${id}`,
    addUser: async (_phone, _name, id) => {
      adds.push(id);
      if (o.addGate) await o.addGate;
      return o.addResults?.[id] ?? { ok: true, line: LINES[id] };
    },
  });
  store.saveUser({ phone: PHONE, name: "Sam", agents: ["social"], greeted: ["social"], poolLines: { "p-social": LINES.social }, ...o.user });
  let n = 0;
  const to = (persona: PersonaId, text: string, extra: Partial<Inbound> = {}) =>
    engine.handle({ persona, sender: PHONE, text, handle: HANDLE[persona], messageId: `m${++n}`, lineKnown: true, ...extra });
  const dm = (text: string) => to("social", text);
  const pending = () => store.kv("shared", PHONE).get<{ from: PersonaId; agents: { id: PersonaId; consent: string }[] }>("recruit");
  return { store, engine, clock, adds, to, dm, pending, user: () => store.user(PHONE) };
}

// Race a turn against a wall-clock limit: a hand-off must never block on the add or a slow agent.
export async function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} waited > ${ms} ms`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
