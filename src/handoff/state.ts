// Agents recruit each other. Every agent has a `bring_in` tool (the engine adds it): when a student's message needs
// another agent's area, the agent they're texting offers it ("want Penny to check the cost?"). On a yes, that agent
// is added under its own number and texts first with its hello, contact card and an answer. The model only
// PROPOSES; whether a hand-off happens is decided here, from the student's own words and the clock.
//
// The rules this state machine owns (each one was a live failure first; the test that pins it is named):
//  1. One shot: any reply to an offer that isn't yes or no drops it.
//       handoff-engine "'no' drops the offer; anything that isn't yes or no also drops it"
//  2. An offer lives OFFER_TTL_MS (10 min); a later yes is just a message.
//       handoff-state "an offer expires after OFFER_TTL…", handoff-engine "a 'yes' after the offer expired…"
//  3. A yes in another hand-off agent's thread counts only for PARTY_TTL_MS (3 min).
//       handoff-engine "a 'yes' in another hand-off agent's thread only counts for a few minutes…"
//  4. In another agent's thread only a PLAIN_YES accepts ("ok", "k", "bet" are about that agent).
//       handoff-engine "in another agent's thread only a real yes counts, not 'ok'"
//  5. ownQuestion veto: if that agent's last text asked its own question, a yes there answers it, not the offer.
//       handoff-engine "'yes option 1' to Dean (answering his own 'your call') goes to Dean…"
//  6. The cooldown stops only a bare yes to an agent that just answered; a new plan or a named ask goes through.
//       handoff-engine "an agent that just answered a hand-off isn't run again…", "the cooldown only stops a duplicate…"
//  7. The cooldown is recorded only after the agent really answered.
//       handoff-engine "cooldown recorded only after a real answer…"
// Consent itself lives in tool.ts: the student asking for the agent ("can penny help") AND the model setting asked=true.
import type { Store } from "../store.ts";
import type { PersonaId, UserProfile } from "../types.ts";

export const OFFER_TTL_MS = 10 * 60_000;
// A yes texted to another agent of the same hand-off (Penny answered first, so they replied in her thread) counts
// for a shorter while: later on, a "yes" there is more likely about that agent's own question.
export const PARTY_TTL_MS = 3 * 60_000;
// An agent that just answered a hand-off isn't run again for this person this soon (the offerer asked anyway and they
// said yes, or the model called bring_in twice): one answer per agent, not two.
export const HANDOFF_COOLDOWN_MS = 3 * 60_000;
export const handoffs = (store: Store, phone: string) => store.kv("shared", phone).get<Partial<Record<PersonaId, number>>>("handoffs") ?? {};

export interface RecruitAsk {
  id: PersonaId;
  ask: string; // what that agent should do, in the student's words
  consent: "pending" | "given" | "none"; // none = they already have this agent
}
export interface Pending {
  from: PersonaId; // the agent that offered (the conversation it was offered in)
  text: string; // what the student said
  offeredAt: number;
  agents: RecruitAsk[];
  party?: PersonaId[]; // every agent in this hand-off (the offerer + everyone it brought in): a yes to any of them counts
}

// May this inbound answer the offer? On a shared number any thread; else the offerer's thread, or (briefly) the
// thread of another agent from the same hand-off.
export function answersOffer(p: Pending, persona: PersonaId, lineKnown: boolean | undefined, now: number): boolean {
  const age = now - p.offeredAt;
  if (age >= OFFER_TTL_MS) return false;
  if (!lineKnown || p.from === persona) return true;
  return age < PARTY_TTL_MS && Boolean(p.party?.includes(persona));
}

export const getPending = (store: Store, phone: string) => store.kv("shared", phone).get<Pending>("recruit");
export const setPending = (store: Store, phone: string, p: Pending | undefined) =>
  store.kv("shared", phone).set("recruit", p?.agents.length ? p : undefined);

export const YES = /^\s*(y|ya|yes|yea|yeah|yep|yup|sure|ok|okay|k|please|pls|do it|go ahead|sounds good|bet|let'?s go|absolutely|of course)\b/i;
const NO_START = /^\s*(n|no|nah|nope|not now|no thanks|nvm|never ?mind|don'?t)\b/i;
const NO_WORD = /\b(no|nah|nope)\b/i; // "please no"; not "don't" ("sure, i don't mind" is a yes)
// A short answer to the offer. "no" anywhere wins ("please no"); a question or a long message isn't an answer.
// In another agent's thread (not the offerer's) only a plain yes accepts; "ok" / "k" / "bet" there are about that agent.
export const PLAIN_YES = /^\s*(y|ya|yes|yea|yeah|yep|yup|sure)\b/i;

// A natural short answer: "sure, i don't mind" and "yes that would be great" are yes; "please no" is no; a question
// or a long message about something else is neither.
export function consentFromText(text: string): "yes" | "no" | undefined {
  const words = text.trim().split(/\s+/).length;
  if (NO_START.test(text) || (NO_WORD.test(text) && words <= 5)) return "no";
  if (text.includes("?") || words > 8) return undefined;
  return YES.test(text) ? "yes" : undefined;
}

export const has = (u: UserProfile, id: PersonaId) => Boolean(u.agents?.includes(id) && u.greeted?.includes(id));
