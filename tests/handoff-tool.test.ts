// bring_in: the model may propose a hand-off; the tool decides consent from the student's own words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recruitTool } from "../src/handoff/tool.ts";
import type { Store } from "../src/store.ts";
import { NAMES, PHONE, T0, setup } from "./helpers.ts";

const tool = (store: Store, text: string, now = T0) =>
  recruitTool({ store, names: NAMES, from: "social", text, now: () => now, needsAdd: () => false, startAdd: () => {} });
const recruit = (s: ReturnType<typeof setup>) => s.store.kv("shared", PHONE).get<{ agents: { id: string; consent: string }[] }>("recruit");

test("bring_in refuses to recruit yourself and needs a named agent (never a guess from the text)", async () => {
  // origin: recruit.test.ts 'bring_in refuses to recruit yourself'; keyless name-guess arm cut with the fake model
  const s = setup();
  const ctx = s.engine.ctx("social", s.user());
  assert.match(await tool(s.store, "hmm").run({ agent: "social" }, ctx), /^error/);
  assert.match(await tool(s.store, "hmm").run({ agent: "Sunny" }, ctx), /^error/);
  assert.match(await tool(s.store, "can dean check my week?").run({}, ctx), /^error: say which agent/);
  assert.equal(recruit(s), undefined, "nothing pending");
});

test("bring_in takes a display name ('Penny'), and never recruits whoever else the text mentions", async () => {
  // origin: recruit-review.test.ts 'S3', live 2026-10-11 (Gemini passed "Penny", not "financial")
  const s = setup();
  const r = await tool(s.store, "dean said the beach trip is saturday, how much is it").run({ agent: "Penny", ask: "price it" }, s.engine.ctx("social", s.user()));
  assert.doesNotMatch(r, /^error/, r);
  assert.deepEqual(recruit(s)?.agents.map((a) => [a.id, a.consent]), [["financial", "pending"]]);
});

test("asked=true is not consent unless the student named the agent", async () => {
  // origin: recruit-review.test.ts 'S4', live failure 2026-10-11 (model set asked=true on its own)
  const s = setup();
  const r = await tool(s.store, "how much is the beach trip").run({ agent: "financial", ask: "price it", asked: true }, s.engine.ctx("social", s.user()));
  assert.match(r, /^Not sent yet\. Ask ONE short question/);
  assert.deepEqual(recruit(s)?.agents.map((a) => [a.id, a.consent]), [["financial", "pending"]]);
});

test("naming the agent with asked=true is consent: the tool says it's texting now", async () => {
  // origin: recruit.test.ts 'naming an agent is consent' (tool half)
  const s = setup();
  const r = await tool(s.store, "ask penny if i can afford boba").run({ agent: "financial", ask: "boba", asked: true }, s.engine.ctx("social", s.user()));
  assert.match(r, /^Penny is texting them now/);
  assert.deepEqual(recruit(s)?.agents.map((a) => [a.id, a.consent]), [["financial", "given"]]);
});

test("consent needs a request for that agent in the student's words; a negation vetoes it", async () => {
  // origin: review finding 2026-10-12 (any mention of the name counted, so "don't bring penny into this" + asked=true sent her)
  const cases: [string, string][] = [
    ["don't bring penny into this", "pending"],
    ["penny?", "pending"],
    ["can penny help", "given"],
    ["bring penny in", "given"],
  ];
  for (const [text, want] of cases) {
    const s = setup();
    await tool(s.store, text).run({ agent: "financial", ask: "price it", asked: true }, s.engine.ctx("social", s.user()));
    assert.equal(recruit(s)?.agents[0].consent, want, text);
  }
});

test("the cooldown message points at the right thread when Penny speaks through Sunny's (via)", async () => {
  // origin: recruit-review.test.ts 'review: the cooldown message points at the right thread'
  const s = setup({ user: { agents: ["social", "financial"], greeted: ["social", "financial"], via: { financial: "social" } } });
  s.store.kv("shared", PHONE).set("handoffs", { financial: T0 });
  const out = await tool(s.store, "yes", T0 + 60_000).run({ agent: "financial", ask: "price it" }, s.engine.ctx("social", s.user()));
  assert.match(out, /already answered this a moment ago right here/);
});
