// Governance: an agent's text is checked against what actually happened this turn before it goes out.
// G1: "<agent> is texting you" only if the engine dispatched that hand-off. A prompt can ask the model not to
// claim it; only this check guarantees it.
import type { PersonaId } from "./types.ts";

// What the gate knows about a turn.
export interface TurnFacts {
  persona: PersonaId; // who is speaking
  dispatched: PersonaId[]; // agents whose hand-off actually went out this turn
}

export interface Verdict {
  text: string; // what may be sent (possibly rewritten)
  hits: { rule: "G1"; detail: string; agent: PersonaId }[]; // agent: the one claimed but not dispatched
}

// Match on a normalized copy (curly apostrophes → '), edit the original.
export const norm = (s: string) => s.replace(/[’‘]/g, "'");

const CLAIM = new RegExp(
  [
    String.raw`\b(?:is |'s |are )?(?:texting|gonna text|going to text|about to text|will text|'ll text)\b`,
    String.raw`\blooped\b.*\bin\b`,
    String.raw`\bon (?:the|its|his|her) way\b`,
    String.raw`\b(?:is|are|'s|'re) on it\b`,
    // "dean will reach out", "penny's gonna message you", "dean will hit you up", "she'll get in touch"
    String.raw`\b(?:will|'ll|gonna|going to|about to|is|'s|are|'re)\s+(?:reach(?:ing)?\s+out|messag(?:e|ing)|hit(?:ting)?\s+you\s+up|get(?:ting)?\s+in\s+touch)\b`,
    // "i'll have dean text you"
    String.raw`\bhave\s+\S+\s+(?:text|message|reach out|hit you up|get in touch)\b`,
  ].join("|"),
  "i",
);
// A sentence that opens with a question word asks about the agent ("is dean texting me?"); a claim with a tag
// question on the end ("dean's texting you now, cool?") is still a claim.
const QUESTION = /^\s*(?:is|are|was|were|do|does|did|will|would|could|can|should|want|who|what|when|where|why|how)\b/i;
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function g1HandoffClaims(text: string, f: TurnFacts, names: Record<PersonaId, string>): Verdict {
  const hits: Verdict["hits"] = [];
  const sentences = text.match(/[^.!?\n]+[.!?\n]*\s*/g) ?? [text];
  const out = sentences.map((s) => {
    const n = norm(s);
    if (!CLAIM.test(n) || QUESTION.test(n)) return s;
    // Every agent the sentence names must have been dispatched ("penny and dean are on it" with only Penny sent fails).
    const missing = (Object.keys(names) as PersonaId[]).filter(
      (id) => id !== f.persona && !f.dispatched.includes(id) && new RegExp(`\\b${escapeRe(names[id])}\\b`, "i").test(n),
    );
    if (!missing.length) return s;
    for (const id of missing) hits.push({ rule: "G1", detail: `claimed ${names[id]} is texting; not dispatched`, agent: id });
    return `want ${missing.map((id) => names[id].toLowerCase()).join(" and ")} to jump in? `;
  });
  return hits.length ? { text: out.join("").trim(), hits } : { text, hits };
}

// Runs in Engine.replyOrThrow between the model's reply and history.
export function govern(text: string, f: TurnFacts, names: Record<PersonaId, string>): Verdict {
  return g1HandoffClaims(text, f, names);
}
