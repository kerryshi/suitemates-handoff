// bring_in: the model proposes a hand-off; this tool records it with the consent the STUDENT gave, not the model.
import type { Store } from "../store.ts";
import type { PersonaId, Tool, UserProfile } from "../types.ts";
import { PERSONA_IDS } from "../types.ts";
import { escapeRe } from "../governance.ts";
import { consentFromText, getPending, handoffs, has, HANDOFF_COOLDOWN_MS, OFFER_TTL_MS, setPending, type Pending } from "./state.ts";

export interface RecruitDeps {
  store: Store;
  names: Record<PersonaId, string>;
  from: PersonaId;
  text: string; // the student's message this turn
  now: () => number;
  needsAdd: (id: PersonaId, user: UserProfile) => boolean;
  startAdd: (id: PersonaId, user: UserProfile) => void; // begin the add now, so a yes doesn't wait on it
}

export function recruitTool(d: RecruitDeps): Tool {
  const others = PERSONA_IDS.filter((id) => id !== d.from);
  const list = others.map((id) => `${d.names[id]} (${id})`).join(", ");
  return {
    name: "bring_in",
    description:
      `Bring another agent in: ${list}. Use it when the message needs that agent's area (money, costs, budget → financial; ` +
      "classes, deadlines, exams → academic; plans, people, events → social), or when they ask for that agent by name " +
      "(asked=true). That agent then texts them first from its own number. You ask ONE short question first unless " +
      "asked=true. Call it in the same turn as your other tools; never answer for the other agent.",
    parameters: {
      properties: {
        agent: { type: "string", enum: others, description: "who to bring in" },
        ask: { type: "string", description: "what that agent should do for them, in their words, e.g. 'price the beach trip'" },
        asked: { type: "boolean", description: "true only when the student asked for that agent themselves" },
      },
      required: ["agent", "ask"],
    },
    async run(args, ctx) {
      // The id or the display name ("financial" or "Penny"): models use both.
      const given = typeof args.agent === "string" ? args.agent.trim().toLowerCase() : "";
      const pick = (id: PersonaId) => id === given || d.names[id].toLowerCase() === given;
      if (given && (d.from === given || d.names[d.from].toLowerCase() === given)) return `error: that's you; bring in one of: ${list}`;
      // Never a guess from the text: the model must say which agent.
      const agent = given ? others.find(pick) : undefined;
      if (!agent) return `error: say which agent: ${list}`;
      // Consent is the student asking for that agent in their own words, not the model saying so. Both must hold.
      const asked = requested(d.text, d.names[agent]) && args.asked === true;
      const ask = typeof args.ask === "string" && args.ask.trim() ? args.ask.trim().slice(0, 200) : d.text.slice(0, 200);
      const user = ctx.user;
      const consent = has(user, agent) ? "none" : asked ? "given" : "pending";
      const n0 = d.names[agent];
      const lastRun = handoffs(d.store, user.phone)[agent];
      // Only a duplicate is stopped: a bare yes to a question that hand-off already answered. A new plan ("actually nyc
      // instead") or naming the agent ("ask penny about the hotel") always goes through.
      const bareYes = consentFromText(d.text) === "yes";
      if (consent === "none" && !asked && bareYes && lastRun !== undefined && d.now() - lastRun < HANDOFF_COOLDOWN_MS)
        return `${n0} already answered this a moment ago ${user.via?.[agent] ? "right here" : `in ${n0}'s own thread`}. Don't ask about ${n0} again; just point them there.`;
      const p = getPending(d.store, user.phone);
      const sameTurn = p && p.from === d.from && p.text === d.text && d.now() - p.offeredAt < OFFER_TTL_MS;
      const base: Pending = sameTurn ? p : { from: d.from, text: d.text, offeredAt: d.now(), agents: [] };
      setPending(d.store, user.phone, {
        ...base,
        agents: [...base.agents.filter((a) => a.id !== agent), { id: agent, ask, consent }],
        party: [...new Set([...(base.party ?? [d.from]), agent])],
      });
      if (consent !== "none" && d.needsAdd(agent, user)) d.startAdd(agent, user);
      const n = d.names[agent];
      if (consent === "none")
        return `${n} is already in their phone and will answer this ${user.via?.[agent] ? "right here" : `in ${n}'s own thread`} now. Say so in a few words; don't answer for ${n}.`;
      if (consent === "given") return `${n} is texting them now from ${n}'s own number. Say so in a few words; don't answer for ${n}.`;
      return `Not sent yet. Ask ONE short question: should ${n} jump in on "${ask}"? (yes/no). Don't answer for ${n}.`;
    },
  };
}

// Did the student ask for this agent? A request word right before the name ("ask penny", "can penny help", "bring
// penny in", "loop in penny"); a bare mention ("penny?") isn't one. Read per clause (split on , ; . ! ? and "but"):
// any clause naming the agent that has a negation before the name ("no need to ask penny", "you don't have to bring
// penny in"), says "leave penny out", or opens with a question word ("did you ask penny already?", "why would penny
// care", "will penny roast me?") vetoes the whole text. "can" still asks ("can penny help"), and a negation in a
// clause that doesn't name the agent doesn't touch it ("i have no money, can penny help").
const VERBS = "ask|get|bring|have|add|text|let|loop in|loop|need|want|involve";
const REQUEST = String.raw`\b(?:${VERBS}|can)\s+(?:in\s+)?`;
const NEGATION = /\b(?:don'?t|do not|doesn'?t|does not|no|not|never|without|nobody|no one|stop)\b|n't\b/i;
const QUESTION = /^\s*(?:did|do|does|why|what|how|who|when|where|is|are|was|were|will|would|could|should|has|had)\b/i;
export function requested(text: string, name: string): boolean {
  const n = new RegExp(String.raw`\b${escapeRe(name)}\b`, "i");
  const clauses = text.replace(/[’‘]/g, "'").split(/[,;.!?\n]+|\bbut\b/i);
  const leave = new RegExp(String.raw`\bleave\s+${escapeRe(name)}\s+out\b`, "i");
  // Any clause that negates or asks about the agent vetoes the whole text ("ask penny. wait, don't ask penny").
  const named = clauses.filter((c) => n.test(c));
  if (named.some((c) => NEGATION.test(c.slice(0, c.search(n))) || leave.test(c) || QUESTION.test(c))) return false;
  const req = new RegExp(REQUEST + escapeRe(name) + String.raw`\b`, "i");
  return named.some((c) => req.test(c));
}
