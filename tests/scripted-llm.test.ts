// ScriptedLlm drives the demo with no API key: an exact script, and a loud failure for anything off-script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScriptedLlm } from "../src/llm/scripted.ts";
import { NAMES } from "./helpers.ts";

const sys = (name: string) => `You are ${name}, one of three texting agents.`;

test("scripted model: rules match by persona and message, and each is consumed once, in order", async () => {
  // origin: test double, no live failure
  const llm = new ScriptedLlm(NAMES, [
    { persona: "social", when: /beach/, then: { toolCalls: [{ name: "bring_in", args: { agent: "financial", ask: "price it" } }] } },
    { persona: "social", when: "tool", then: { text: "want penny to jump in?" } },
    { when: /beach/, then: { text: "second beach" } },
  ]);
  const first = await llm.chat({ system: sys("Sunny"), messages: [{ role: "user", text: "beach saturday" }], tools: [] });
  assert.ok("toolCalls" in first && first.toolCalls[0].name === "bring_in");
  const second = await llm.chat({ system: sys("Sunny"), messages: [{ role: "tool", results: [{ name: "bring_in", result: "Not sent yet" }] }], tools: [] });
  assert.deepEqual(second, { text: "want penny to jump in?" });
  assert.deepEqual(await llm.chat({ system: sys("Penny"), messages: [{ role: "user", text: "beach?" }], tools: [] }), { text: "second beach" });
  assert.equal(llm.remaining(), 0);
});

test("scripted model: an unexpected call throws instead of improvising", async () => {
  // origin: test double, no live failure
  const llm = new ScriptedLlm(NAMES, [{ persona: "financial", when: /cost/, then: { text: "about $45" } }]);
  await assert.rejects(llm.chat({ system: sys("Sunny"), messages: [{ role: "user", text: "cost?" }], tools: [] }), /unexpected call/);
  await assert.rejects(llm.chat({ system: sys("Penny"), messages: [{ role: "user", text: "hi" }], tools: [] }), /unexpected call/);
  await assert.rejects(llm.json(), /unexpected call/);
  assert.equal(llm.remaining(), 1, "a failed match consumes nothing");
});
