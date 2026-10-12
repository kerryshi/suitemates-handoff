// The pure rules: who may answer an offer, and what counts as a yes or a no.
import { test } from "node:test";
import assert from "node:assert/strict";
import { answersOffer, consentFromText, OFFER_TTL_MS, PARTY_TTL_MS, PLAIN_YES, type Pending } from "../src/handoff/state.ts";

const offer: Pending = { from: "social", text: "beach trip", offeredAt: 0, agents: [{ id: "academic", ask: "check saturday", consent: "pending" }], party: ["social", "financial", "academic"] };

test("consent: 'no' wins over a polite yes-word, and a question isn't a yes", () => {
  // origin: recruit-review.test.ts 'consent: no wins', live 2026-10-11 ("please no" read as yes)
  assert.equal(consentFromText("please no"), "no");
  assert.equal(consentFromText("ok so what time?"), undefined);
  assert.equal(consentFromText("yes!"), "yes");
  assert.equal(consentFromText("yeah do it"), "yes");
  assert.equal(consentFromText("nah im good"), "no");
});

test("consent reads natural answers: 'sure, i don't mind' and 'yes that would be great' are yes; 'please no' and 'nah im good' are no", () => {
  // origin: recruit-review.test.ts 'consent reads natural answers', live 2026-10-11
  for (const t of ["sure, i don't mind", "yes that would be great", "yes please, go ahead", "yeah do it", "yes!", "Yes", "sure thing"]) assert.equal(consentFromText(t), "yes", t);
  for (const t of ["please no", "no thanks", "nah im good", "nope", "not now", "don't", "no, i'm good"]) assert.equal(consentFromText(t), "no", t);
  for (const t of ["ok so what time?", "what's the cost?", "maybe later, what else is going on this weekend at unc"]) assert.equal(consentFromText(t), undefined, t);
});

test("an offer expires after OFFER_TTL in every thread; another hand-off agent's thread only counts inside PARTY_TTL", () => {
  // origin: recruit.test.ts 'yes in another hand-off agent's thread only counts for a few minutes'
  assert.equal(answersOffer(offer, "social", true, OFFER_TTL_MS - 1), true, "offerer's thread, just inside");
  assert.equal(answersOffer(offer, "social", true, OFFER_TTL_MS), false, "offerer's thread, expired");
  assert.equal(answersOffer(offer, "social", false, OFFER_TTL_MS), false, "shared number, expired");
  assert.equal(answersOffer(offer, "financial", true, PARTY_TTL_MS - 1), true, "party thread, inside");
  assert.equal(answersOffer(offer, "financial", true, PARTY_TTL_MS), false, "party thread, past the window");
  assert.equal(answersOffer({ ...offer, party: ["social", "academic"] }, "financial", true, 0), false, "not in the hand-off");
  assert.equal(answersOffer(offer, "financial", false, 0), true, "shared number: any thread");
});

test("in another agent's thread only a plain yes accepts: 'ok', 'k', 'bet' are about that agent", () => {
  // origin: recruit-review.test.ts 'review #2b'
  for (const t of ["yes", "yeah", "yep", "sure", "Yes"]) assert.ok(PLAIN_YES.test(t), t);
  for (const t of ["ok", "k", "bet", "go ahead"]) assert.ok(!PLAIN_YES.test(t), t);
});
