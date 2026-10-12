// The hand-off end to end through Engine.handle: offer, yes/no, same-turn consent, fallbacks, duplicates.
// Each test is a failure seen live on 2026-10-11 (HackNC) or in a review of the fix; `origin` names where.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendAll } from "../src/transport.ts";
import type { Outbound, PersonaId } from "../src/types.ts";
import { BEACH, HANDLE, LINES, NAMES, PHONE, bringIn, deferred, lastUser, me, setup, within, withSpy } from "./helpers.ts";

const from = (out: Outbound[], id: PersonaId) => out.filter((o) => o.persona === id);
const answered = (out: Outbound[], id: PersonaId) => out.some((o) => o.persona === id && o.text === `${NAMES[id]} answer`);
// Sunny brings in Penny and Dean on the beach plan.
const beachBoth = withSpy((req) => (me(req) === "Sunny" && /beach/i.test(lastUser(req) ?? "") ? bringIn(["financial", "price the beach trip"], ["academic", "check saturday"]) : undefined));

test("the offer: Sunny asks once, Penny and Dean are added in the background, nothing waits on the add", async () => {
  // origin: recruit.test.ts 'the offer', live 2026-10-11 (the provider CLI add took ~1.5 s and held the reply)
  const gate = deferred();
  const s = setup({ llm: beachBoth, addGate: gate.promise });
  const out = await within(1000, s.dm(BEACH), "the offer");
  assert.deepEqual(out.map((o) => [o.persona, o.handle]), [["social", HANDLE.social]]);
  assert.match(out[0].text, /jump in/);
  assert.equal(s.pending()?.from, "social");
  assert.deepEqual(s.pending()?.agents.map((a) => [a.id, a.consent]), [["financial", "pending"], ["academic", "pending"]]);
  assert.deepEqual(s.adds, ["financial", "academic"]);
  gate.resolve();
});

test("'yes' on Sunny's thread: Sunny acks, then Penny and Dean each text first from their own number with hello, card, answer", async () => {
  // origin: recruit.test.ts ''yes' on Sunny's thread'
  const s = setup({ llm: beachBoth });
  await s.dm(BEACH);
  const out = await s.dm("yes!");
  assert.equal(out[0].persona, "social");
  assert.equal(out[0].handle, HANDLE.social);
  assert.match(out[0].text, /Penny and Dean are texting you now from their own numbers/);
  for (const id of ["financial", "academic"] as const) {
    const mine = from(out, id);
    assert.ok(mine.every((o) => o.handle === `dm:${PHONE}` && !o.via), `${id} speaks from its own number`);
    assert.equal(mine.find((o) => o.card)?.card?.phone, LINES[id], `${id}'s card carries the number this person texts`);
    assert.deepEqual(mine.map((o) => (o.card ? "card" : o.text === `${NAMES[id]} answer` ? "answer" : "hello")), ["hello", "card", "answer"]);
  }
  assert.deepEqual([...(s.user().agents ?? [])].sort(), ["academic", "financial", "social"]);
  assert.deepEqual([...(s.user().greeted ?? [])].sort(), ["academic", "financial", "social"]);
  assert.deepEqual(s.user().poolLines, { "p-social": LINES.social, "p-financial": LINES.financial, "p-academic": LINES.academic });
  assert.equal(s.pending(), undefined);
  // A second "yes" is just a message to Sunny now: nobody is re-added or re-introduced.
  const again = await s.dm("yes");
  assert.deepEqual(again.map((o) => [o.persona, o.text]), [["social", "Sunny reply"]]);
  assert.equal(s.adds.length, 2);
});

test("'no' drops the offer; anything that isn't yes or no also drops it (one-shot) and gets a normal reply", async () => {
  // origin: recruit.test.ts ''no' drops the offer'
  const s = setup();
  await s.dm(BEACH);
  const no = await s.dm("nah");
  assert.deepEqual(no.map((o) => o.text), ["no worries"]);
  assert.equal(s.pending(), undefined);
  await s.dm(BEACH);
  const other = await s.dm("what time do we leave?");
  assert.deepEqual(other.map((o) => [o.persona, o.text]), [["social", "Sunny reply"]]);
  assert.equal(s.pending(), undefined);
  assert.deepEqual(s.user().agents, ["social"]);
});

test("naming an agent is consent: no question, Penny texts first in the same turn", async () => {
  // origin: recruit.test.ts 'naming an agent is consent'
  const s = setup();
  const out = await s.dm("ask penny if i can afford boba");
  assert.equal(out[0].persona, "social");
  assert.ok(answered(out, "financial"));
  assert.ok(from(out, "financial").some((o) => o.card));
  assert.equal(s.pending(), undefined);
  assert.ok(s.user().agents?.includes("financial"));
});

test("an agent they already have answers from its own thread right away: no question, no second hello", async () => {
  // origin: recruit.test.ts 'an agent they already have'
  const s = setup({ llm: beachBoth, user: { agents: ["social", "financial"], greeted: ["social", "financial"], poolLines: { "p-social": LINES.social, "p-financial": LINES.financial } } });
  const out = await s.dm(BEACH);
  assert.deepEqual(from(out, "financial").map((o) => [o.handle, o.text, Boolean(o.card)]), [[`dm:${PHONE}`, "Penny answer", false]]);
  assert.deepEqual(s.pending()?.agents.map((a) => a.id), ["academic"], "Dean still waits for a yes");
  assert.deepEqual(s.adds, ["academic"], "Penny is not re-added");
});

test("a 'yes' in another hand-off agent's thread only counts for a few minutes; the offerer's own thread keeps it longer", async () => {
  // origin: recruit.test.ts 'a yes in another hand-off agent's thread only counts for a few minutes'
  const s = setup({ llm: beachBoth, user: { agents: ["social", "financial"], greeted: ["social", "financial"] } });
  await s.dm(BEACH); // Penny is theirs (answers now), Dean pending
  s.clock.advance(4 * 60_000); // past PARTY_TTL_MS, inside OFFER_TTL_MS
  const out = await s.to("financial", "yes");
  assert.deepEqual(out.map((o) => [o.persona, o.text]), [["financial", "Penny reply"]], "4 min later, a yes to Penny is about Penny");
  assert.deepEqual(s.pending()?.agents.map((a) => a.id), ["academic"]);
  assert.ok(answered(await s.dm("yes"), "academic"), "still fine in Sunny's own thread");
});

test("a 'yes' after the offer expired is just a message: nobody is brought in", async () => {
  // origin: recruit.ts OFFER_TTL_MS (10 min); the engine half of the TTL rule
  const s = setup();
  await s.dm(BEACH);
  s.clock.advance(11 * 60_000);
  const out = await s.dm("yes");
  assert.deepEqual(out.map((o) => [o.persona, o.text]), [["social", "Sunny reply"]]);
  assert.deepEqual(s.user().agents, ["social"]);
});

test("if Penny can't be added (full, dead token), she still answers: through Sunny's thread, with no contact card", async () => {
  // origin: recruit.test.ts 'if Penny can't be added' + review S7 (a card in a borrowed thread puts Penny's name on Sunny's number)
  const s = setup({ llm: beachBoth, addResults: { financial: { ok: false, error: "financial project is full (100/100 users)" } } });
  await s.dm(BEACH);
  const out = await s.dm("yes");
  const penny = from(out, "financial");
  assert.ok(penny.length >= 2, "hello + answer");
  assert.ok(penny.every((o) => o.via === "social" && o.handle === `dm:${PHONE}`));
  assert.ok(!penny.some((o) => o.card));
  assert.ok(from(out, "academic").every((o) => !o.via), "Dean was added fine and uses his own number");
  assert.match(out[0].text, /Dean is texting you now from their own number, and Penny is jumping in right here/);
  assert.equal(s.user().via?.financial, "social");
  assert.equal(s.user().poolLines?.["p-financial"], undefined);
});

test("the 'on it' line only promises own numbers for agents that have one (single shared number: they jump in here)", async () => {
  // origin: recruit.test.ts 'the on it line only promises own numbers'
  const s = setup({ llm: beachBoth, ownNumbers: false });
  await s.dm(BEACH);
  const out = await s.dm("yes");
  assert.doesNotMatch(out[0].text, /own number|Unknown Senders/);
  assert.match(out[0].text, /Penny and Dean are jumping in right here/);
  assert.deepEqual(s.adds, [], "nothing to add anyone to");
});

test("a handoff answer that comes back empty is retried once; if it fails again the new agent sends no glitch text", async () => {
  // origin: recruit.test.ts 'a handoff answer that comes back empty is retried once', live 2026-10-11 (Gemini empty after a tool call)
  for (const failures of [1, 2]) {
    let deanFails = failures;
    const s = setup({
      llm: withSpy((req) => {
        if (me(req) === "Dean" && lastUser(req)?.startsWith("[handoff") && deanFails-- > 0) throw new Error("model returned no text");
        return beachBoth.chat(req);
      }),
    });
    await s.dm(BEACH);
    const dean = from(await s.dm("yes"), "academic");
    assert.ok(dean.some((o) => o.card), "the hello and card still go out");
    assert.ok(!dean.some((o) => /glitch/.test(o.text)), `no glitch text (failures=${failures})`);
    assert.equal(answered(dean, "academic"), failures === 1, `answer after one retry only (failures=${failures})`);
  }
});

test("a 'yes' after the background add settled reuses it (no second add, no wait)", async () => {
  // origin: recruit-review.test.ts 'S1'
  const s = setup();
  await s.dm(BEACH);
  await new Promise((r) => setImmediate(r)); // the add settles while they read the question
  const gate = deferred();
  (s.engine.d as { addUser?: unknown }).addUser = async (_p: string, _n: string, id: PersonaId) => (s.adds.push(id), await gate.promise, { ok: true, line: LINES[id] });
  await within(1000, s.dm("yes"), "the yes");
  assert.deepEqual(s.adds, ["financial"], `added ${s.adds.length}x`);
  gate.resolve();
});

test("two yeses in flight at once bring Penny in once: one hello and card, not two", async () => {
  // origin: recruit-review.test.ts 'S2' (double hello); the sign-up greeting it covered is cut, the one-shot offer is the same race
  const s = setup();
  await s.dm(BEACH);
  const [a, b] = await Promise.all([s.dm("yes"), s.dm("yes")]);
  assert.equal([...a, ...b].filter((o) => o.card).length, 1);
  assert.equal([...a, ...b].filter((o) => o.persona === "financial" && o.text === "Penny answer").length, 1);
});

test("someone who texted in (no agents list yet) keeps their first agent after a recruit", async () => {
  // origin: recruit-review.test.ts 'S6'
  const s = setup({ user: { agents: undefined, greeted: undefined, poolLines: undefined } });
  await s.dm(BEACH);
  await s.dm("yes");
  const u = s.user();
  assert.ok(u.agents?.includes("social") && u.greeted?.includes("social"), `agents=${JSON.stringify(u.agents)} greeted=${JSON.stringify(u.greeted)}`);
});

test("with a deliver hook, 'yes' returns the ack at once; each agent's texts go out as soon as that agent is ready", async () => {
  // origin: recruit-review.test.ts 'S8', live 2026-10-11 (the ack waited on the slowest agent)
  const slowGate = deferred();
  const got = deferred();
  const delivered: Outbound[][] = [];
  const s = setup({ llm: withSpy(async (req) => (lastUser(req)?.startsWith("[handoff") ? (await slowGate.promise, undefined) : undefined)) });
  Object.assign(s.engine.d, { deliver: async (outs: Outbound[]) => void (delivered.push(outs), got.resolve()) });
  await s.dm(BEACH);
  const out = await within(1000, s.dm("yes"), "the ack");
  assert.deepEqual(out.map((o) => o.persona), ["social"], "only the ack comes back with the turn");
  assert.equal(delivered.length, 0, "Penny is still thinking");
  slowGate.resolve();
  await within(1000, got.promise, "Penny's texts");
  const penny = delivered.flat().filter((o) => o.persona === "financial");
  assert.ok(penny.some((o) => o.card) && penny.some((o) => o.text === "Penny answer"), JSON.stringify(delivered));
});

test("a 'yes' in the thread of an agent from the same hand-off counts (Penny answered first, so they said yes to her)", async () => {
  // origin: recruit-review.test.ts 'a yes in the thread of an agent from the same hand-off counts'
  const s = setup({ llm: beachBoth, user: { agents: ["social", "financial"], greeted: ["social", "financial"] } });
  await s.dm(BEACH);
  const out = await s.to("financial", "Yes");
  assert.ok(answered(out, "academic"), JSON.stringify(out.map((o) => [o.persona, o.text])));
  assert.equal(out[0].persona, "financial", "the ack comes from the agent they said yes to");
  assert.equal(s.pending(), undefined);
});

test("a 'yes' to an agent outside the hand-off doesn't accept it", async () => {
  // origin: recruit-review.test.ts 'a yes to an agent outside the hand-off'
  const s = setup({
    user: { agents: ["social", "financial"], greeted: ["social", "financial"] },
    llm: withSpy((req) => (me(req) === "Sunny" && /beach/i.test(lastUser(req) ?? "") ? bringIn(["academic", "check saturday"]) : undefined)),
  });
  await s.dm(BEACH);
  const out = await s.to("financial", "yes");
  assert.ok(!out.some((o) => o.persona === "academic"));
});

// Review of kerry/yes-any-thread: another hand-off agent's thread may only ACCEPT, never consume.
function party(deanSays?: string) {
  const have: PersonaId[] = deanSays ? ["social", "academic"] : ["social", "financial"];
  return setup({
    user: { agents: have, greeted: have },
    llm: withSpy((req) => {
      if (me(req) === "Sunny" && /beach/i.test(lastUser(req) ?? ""))
        return deanSays ? bringIn(["academic", "check saturday"], ["financial", "price it"]) : bringIn(["financial", "price it"], ["academic", "check saturday"]);
      if (deanSays && me(req) === "Dean" && lastUser(req)?.startsWith("[handoff")) return { text: deanSays };
      return undefined;
    }),
  });
}

test("a non-answer to Penny keeps Sunny's offer; a later yes to Sunny still brings Dean", async () => {
  // origin: recruit-review.test.ts 'review #1'
  const s = party();
  await s.dm(BEACH);
  assert.deepEqual((await s.to("financial", "thanks penny")).map((o) => [o.persona, o.text]), [["financial", "Penny reply"]], "Penny hears it");
  const yes = await s.dm("yes");
  assert.ok(answered(yes, "academic"), JSON.stringify(yes.map((o) => [o.persona, o.text])));
});

test("'yes option 1' to Dean (answering his own 'your call') goes to Dean, doesn't recruit Penny or drop her offer", async () => {
  // origin: recruit-review.test.ts 'review #2' ("ok option 1" live); "yes" here so the ownQuestion veto, not PLAIN_YES, is what stops it
  const s = party("option 1: take it then go (~85%). option 2: skip it (~61%). your call.");
  await s.dm(BEACH);
  const ok = await s.to("academic", "yes option 1");
  assert.deepEqual(ok.map((o) => o.persona), ["academic"], "Penny not recruited off Dean's question");
  assert.ok(answered(await s.dm("yes"), "financial"), "the offer is still there in Sunny's thread");
});

test("in another agent's thread only a real yes counts, not 'ok'", async () => {
  // origin: recruit-review.test.ts 'review #2b'
  const s = party();
  await s.dm(BEACH);
  assert.deepEqual((await s.to("financial", "ok")).map((o) => o.persona), ["financial"]);
  assert.ok(answered(await s.to("financial", "yeah"), "academic"));
});

test("the party window is ~3 minutes: a yes to Penny at 2.5 min still counts", async () => {
  // origin: recruit-review.test.ts 'review #4'
  const s = party();
  await s.dm(BEACH);
  s.clock.advance(150_000);
  assert.ok(answered(await s.to("financial", "yes"), "academic"));
});

// Live 02:04: they had all three; Sunny brought Penny+Dean (both answered at once), still asked "want penny + dean…?",
// they said "Yes", and Sunny called bring_in for both again: every agent answered the NYC trip twice.
function allThree(extra?: Parameters<typeof withSpy>[0]) {
  return setup({
    user: { agents: ["social", "financial", "academic"], greeted: ["social", "financial", "academic"] },
    llm: withSpy((req) => {
      const hit = extra?.(req);
      if (hit) return hit;
      const text = lastUser(req) ?? "";
      if (me(req) !== "Sunny") return undefined;
      if (/ask penny/i.test(text)) return bringIn(["financial", "the hotel", true]);
      if (/nyc|yes/i.test(text)) return bringIn(["financial", "price nyc"], ["academic", "check fall break"]);
      return undefined;
    }),
  });
}

test("an agent that just answered a hand-off isn't run again for a bare yes a minute later (no duplicate texts)", async () => {
  // origin: recruit-review.test.ts 'an agent that just answered a hand-off isn't run again', live 2026-10-11 02:04
  const s = allThree();
  const first = await s.dm("I want to go to nyc for fall break");
  assert.ok(answered(first, "financial") && answered(first, "academic"));
  s.clock.advance(60_000);
  const again = await s.dm("Yes");
  assert.deepEqual(again.filter((o) => o.persona !== "social").map((o) => o.text), [], "no second round of answers");
});

test("the cooldown only stops a duplicate: a changed plan within 3 min still reaches Penny", async () => {
  // origin: recruit-review.test.ts 'review: a changed plan within 3 min'
  const s = allThree();
  assert.ok(answered(await s.dm("I want to go to nyc for fall break"), "financial"), "first plan priced");
  s.clock.advance(60_000);
  assert.ok(answered(await s.dm("actually nyc instead, how much is that"), "financial"), "changed plan priced too");
});

test("the cooldown never stops a named request: 'ask penny about the hotel too' within 3 min reaches her", async () => {
  // origin: recruit-review.test.ts 'review: naming Penny within 3 min'
  const s = allThree();
  await s.dm("I want to go to nyc for fall break");
  s.clock.advance(60_000);
  assert.ok(answered(await s.dm("ask penny about the hotel too"), "financial"));
});

test("cooldown recorded only after a real answer: if Penny's answer failed, a yes a minute later runs her again", async () => {
  // origin: recruit-review.test.ts 'review: if Penny's hand-off answer failed', review of cf08678
  let failing = true;
  const s = allThree((req) => {
    if (failing && me(req) === "Penny" && lastUser(req)?.startsWith("[handoff")) throw new Error("model returned no text");
    return undefined;
  });
  assert.equal(answered(await s.dm("I want to go to nyc for fall break"), "financial"), false, "Penny's answer failed");
  failing = false;
  s.clock.advance(60_000);
  assert.equal(answered(await s.dm("yes"), "financial"), true, "a yes runs Penny again");
});

test("transport: one failed send doesn't drop the rest of the batch", async () => {
  // origin: recruit-review.test.ts 'S5', live 2026-10-11 ("Target not allowed" dropped Dean's texts)
  const sent: string[] = [];
  const t = { start: async () => {}, send: async (o: Outbound) => { if (o.persona === "financial") throw new Error("Target not allowed"); sent.push(o.text); } };
  await sendAll(t, [{ persona: "social", handle: "h", text: "ack" }, { persona: "financial", handle: "h", text: "penny" }, { persona: "academic", handle: "h", text: "dean" }], () => {});
  assert.deepEqual(sent, ["ack", "dean"]);
});

