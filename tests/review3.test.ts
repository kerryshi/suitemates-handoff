// Review 3 (2026-10-12): each test pins one reviewer finding; docs/evidence/review3-probes-red.txt is the raw red run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { g1HandoffClaims } from "../src/governance.ts";
import { requested } from "../src/handoff/tool.ts";
import { NAMES, PHONE, bringIn, deferred, lastUser, me, setup, withSpy } from "./helpers.ts";
import type { Outbound } from "../src/types.ts";

const handoffBrief = (req: Parameters<typeof me>[0]) => (lastUser(req) ?? "").startsWith("[handoff");

test("S1: in a hand-off answer, a true claim about another agent of the same hand-off passes G1 untouched", async () => {
  // origin: review-3 S1 (recruit turns had dispatched = [], so Penny's true "dean's texting you too" was rewritten)
  const s = setup({
    llm: withSpy((req) => {
      if (me(req) === "Sunny" && /ask penny and ask dean/.test(lastUser(req) ?? "")) return bringIn(["financial", "budget", true], ["academic", "classes", true]);
      if (me(req) === "Penny" && handoffBrief(req)) return { text: "you're good on money. dean's texting you too about classes" };
      return undefined;
    }),
  });
  const outs = await s.dm("ask penny and ask dean if saturday works");
  assert.ok(outs.some((o) => o.persona === "financial" && o.text === "you're good on money. dean's texting you too about classes"));
});

test("S1: a false claim in a hand-off answer becomes an offer from that agent, and a yes in its thread brings the other in", async () => {
  // origin: review-3 S1 (the recruit-turn rewrite asked "want dean to jump in?" but set no offer, so the yes went nowhere)
  const s = setup({ llm: withSpy((req) => (me(req) === "Penny" && handoffBrief(req) ? { text: "dean's texting you about classes" } : undefined)) });
  const first = await s.dm("ask penny if i can afford boba");
  assert.ok(first.some((o) => o.persona === "financial" && /want dean to jump in\?/.test(o.text)));
  assert.equal(s.pending()?.from, "financial");
  const yes = await s.to("financial", "yes");
  assert.ok(yes.some((o) => o.persona === "academic" && o.text === "Dean answer"), "Dean was dispatched");
});

test("P5: a G1 offer never overwrites another agent's live pending offer", async () => {
  // origin: review-3 P5 (Penny's G1 rewrite replaced Sunny's open offer for Dean)
  const s = setup({
    user: { agents: ["social", "financial"], greeted: ["social", "financial"] },
    llm: withSpy((req) => {
      if (me(req) === "Sunny" && /classes/.test(lastUser(req) ?? "")) return bringIn(["academic", "check classes"]);
      if (me(req) === "Penny" && lastUser(req) === "hm") return { text: "dean's texting you now" };
      return undefined;
    }),
  });
  await s.dm("is saturday ok with my classes");
  const before = s.pending();
  await s.to("financial", "hm");
  assert.deepEqual(s.pending(), before);
});

test("S2: a negation anywhere in the clause before the name vetoes consent", () => {
  // origin: review-3 S2
  for (const t of ["no need to ask penny", "don't ever ask penny", "you don't have to bring penny in", "don't bring penny into this"]) assert.equal(requested(t, "Penny"), false, t);
  assert.equal(requested("i have no money, can penny help", "Penny"), true);
});

test("S3: questions about the agent are not requests; 'can penny help' still is", () => {
  // origin: review-3 S3 (will/would/could counted as request openers)
  for (const t of ["will penny roast me?", "why would penny care", "did you ask penny already?", "could penny be mad at me"]) assert.equal(requested(t, "Penny"), false, t);
  for (const t of ["can penny help", "ask penny", "bring penny in", "have penny text me"]) assert.equal(requested(t, "Penny"), true, t);
});

test("S4: G1 reads reach out / message / hit you up / get in touch / have X text as claims, and a trailing '?' is no escape", () => {
  // origin: review-3 S4 (P3: none of these were caught; "dean's texting you now, cool?" skipped on its '?')
  const f = { persona: "social" as const, dispatched: [] };
  for (const t of ["dean will reach out soon", "dean will message you", "dean will hit you up", "dean will get in touch", "i'll have dean text you", "dean's texting you now, cool?"]) {
    assert.equal(g1HandoffClaims(t, f, NAMES).hits.length, 1, t);
  }
  for (const t of ["is dean texting me?", "want dean to jump in?", "will dean text me?"]) assert.equal(g1HandoffClaims(t, f, NAMES).hits.length, 0, t);
});

test("names with regex characters are matched literally", () => {
  // origin: review-3 nit (names went into regexes unescaped)
  const names = { ...NAMES, academic: "D.n" };
  assert.equal(g1HandoffClaims("Don is texting you now", { persona: "social", dispatched: [] }, names).hits.length, 0);
  assert.equal(requested("ask Don", "D.n"), false);
});

test("S5: engine.settled() waits for every delivery still in flight", async () => {
  // origin: review-3 S5 (npm run chat could exit on EOF before a recruited agent's texts were delivered)
  const gate = deferred();
  const s = setup();
  const sent: Outbound[] = [];
  s.engine.d.deliver = async (outs) => {
    await gate.promise;
    sent.push(...outs);
  };
  await s.dm("ask penny if i can afford boba");
  let done = false;
  const settled = s.engine.settled().then(() => (done = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  gate.resolve();
  await settled;
  assert.ok(sent.some((o) => o.persona === "financial" && o.text === "Penny answer"));
  void PHONE;
});
