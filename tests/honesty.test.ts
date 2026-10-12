// G1: a text may only say another agent is texting if the engine actually dispatched that hand-off this turn.
// Fixtures are real texts from the night of 2026-10-11.
import { test } from "node:test";
import assert from "node:assert/strict";
import { g1HandoffClaims, type TurnFacts } from "../src/governance.ts";
import { NAMES, PHONE, bringIn, lastUser, me, setup, withSpy } from "./helpers.ts";

const facts = (dispatched: TurnFacts["dispatched"] = []): TurnFacts => ({ persona: "financial", dispatched });

test("G1: a claim that another agent is texting, when no hand-off went out, is rewritten", () => {
  // origin: recruit-honesty.test.ts 'G1: a claim…', live 2026-10-11 01:59 (Penny: "dean's texting you now!")
  for (const t of ["dean's texting you now! 📚", "dean’s texting you now!", "Dean is texting you now", "dean will text you", "i looped dean in, he'll text you shortly"]) {
    const v = g1HandoffClaims(t, facts(), NAMES);
    assert.ok(v.hits.length, `caught: ${t}`);
    assert.doesNotMatch(v.text, /dean.{0,20}text/i, t);
  }
});

test("G1: true claims and plain mentions pass byte-for-byte", () => {
  // origin: recruit-honesty.test.ts 'G1: true claims and plain mentions pass'
  assert.equal(g1HandoffClaims("dean's texting you now! 📚", facts(["academic"]), NAMES).text, "dean's texting you now! 📚");
  for (const t of ["want dean to check if saturday's safe with your classes?", "that's penny's specialty!", "beach trip should run about $45, which is only 9% of the $496 left"]) {
    const v = g1HandoffClaims(t, facts(), NAMES);
    assert.equal(v.text, t);
    assert.equal(v.hits.length, 0);
  }
});

test("engine G1: Penny's false 'dean's texting you now' (no hand-off this turn) never reaches the student or her history", async () => {
  // origin: recruit-honesty.test.ts 'engine: Penny's false…', live 2026-10-11 01:59
  const s = setup({ llm: withSpy(() => ({ text: "dean's texting you now! 📚" })), user: { agents: ["financial"], greeted: ["financial"] } });
  const outs = await s.to("financial", "Yes");
  assert.doesNotMatch(outs.map((o) => o.text).join(" "), /texting you/);
  assert.match(outs[0].text, /want dean to jump in\?/);
  assert.doesNotMatch(s.store.history("financial", PHONE).at(-1)?.text ?? "", /texting you/);
});

test("engine G1: a claim about an agent not dispatched is rewritten even when another one was (Penny went, Dean didn't)", async () => {
  // origin: live 2026-10-11 02:07 (Sunny: "penny and dean are on it" after bringing in only Penny)
  const s = setup({
    llm: withSpy((req) => {
      if (me(req) !== "Sunny") return undefined;
      const last = req.messages.at(-1)!;
      if (last.role === "tool") return { text: "on it. penny is texting you now. dean will text you too." };
      return /ask penny/i.test(lastUser(req) ?? "") ? bringIn(["financial", "boba", true]) : undefined;
    }),
  });
  const out = await s.dm("ask penny if i can afford boba");
  assert.match(out[0].text, /penny is texting you now/, "the true claim stays");
  assert.doesNotMatch(out[0].text, /dean will text/, "the false one goes");
  assert.ok(out.some((o) => o.persona === "financial" && o.text === "Penny answer"));
});

test("G1: one sentence naming two agents is rewritten when either was not dispatched", () => {
  // origin: review finding 2026-10-12 (the check stopped at the first agent named; "are on it" was not read as a claim)
  const sunny = (dispatched: TurnFacts["dispatched"]): TurnFacts => ({ persona: "social", dispatched });
  for (const t of ["penny and dean are on it", "penny and dean are texting you now"]) {
    const v = g1HandoffClaims(t, sunny(["financial"]), NAMES);
    assert.ok(v.hits.length, `caught: ${t}`);
    assert.doesNotMatch(v.text, /dean.{0,20}(text|on it)/i, t);
  }
  // Same sentence, other way round: the agent checked first was dispatched, the other was not.
  assert.ok(g1HandoffClaims("dean and penny are texting you now", sunny(["academic"]), NAMES).hits.length, "penny not dispatched");
  assert.equal(g1HandoffClaims("penny is on it", sunny(["financial"]), NAMES).hits.length, 0);
});

test("engine G1: the rewritten question is a real offer, so a plain 'yes' brings that agent in (and not after it expires)", async () => {
  // origin: review finding 2026-10-12 (G1 asked "want dean to jump in?" but no offer existed, so "yes" went nowhere)
  const claim = withSpy((req) => (me(req) === "Penny" && lastUser(req) === "is dean gonna text me?" ? { text: "dean's texting you now!" } : undefined));
  const user = { agents: ["financial" as const], greeted: ["financial" as const] };
  const s = setup({ llm: claim, user });
  const q = await s.to("financial", "is dean gonna text me?");
  assert.match(q[0].text, /want dean to jump in\?/);
  const yes = await s.to("financial", "yes");
  assert.match(yes[0].text, /Dean is texting you now from their own number/);
  assert.ok(yes.some((o) => o.persona === "academic" && o.text === "Dean answer"), "Dean was dispatched");
  // The same rewritten offer, answered after OFFER_TTL: nothing is dispatched.
  const late = setup({ llm: claim, user });
  await late.to("financial", "is dean gonna text me?");
  late.clock.advance(11 * 60_000);
  const stale = await late.to("financial", "yes");
  assert.ok(!stale.some((o) => o.persona === "academic"), "no hand-off after the offer expired");
  assert.deepEqual(late.adds, []);
});
