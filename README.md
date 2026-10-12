# suitemates-handoff

Three LLM texting agents (Sunny for plans, Penny for money, Dean for school) that bring each other into a
conversation. The model may only **propose** a hand-off. Whether one happens is decided by a small pure state
machine, and a post-generation gate rewrites any "X is texting you" claim the engine did not actually dispatch.

## The idea in 5 lines
1. Every agent gets a core-injected `bring_in` tool; the model calls it when a message touches another agent's area.
2. Consent is checked in code from the **student's** text: a request for that agent ("can penny help", "bring penny in") with no negation in that clause ("no need to ask penny") and not a question about the agent ("did you ask penny already?"), AND the model must also set `asked=true`. Either alone is not consent.
3. Otherwise the agent asks one question, and the next reply is judged by `src/handoff/state.ts`: yes, no, or neither (dropped).
4. Offer expiry, side-thread answers and duplicate suppression are clock-and-text rules, not prompt instructions.
5. G1 (`src/governance.ts`) checks every reply against what was dispatched this turn before it is sent or remembered; a false claim becomes a real offer from the agent that made it ("want dean to jump in?") that a plain yes accepts, unless another agent's offer is still open.

## Demo
`npm install && npm run demo` (no API key). The model's lines come from a script (`scripts/demo.ts`, `src/llm/scripted.ts`);
who answers, the ack, hello + contact card, the expired yes and the G1 rewrite are all decided by `src/`. The script
throws on any model call it did not expect.

```
Sam → Sunny: beach trip saturday, can i afford it?
  Sunny: wrightsville beach, sat 9am, about $45 a person. want penny to check that against your budget?

Sam → Sunny: yes
  Sunny: on it! Penny is texting you now from their own number (nothing showing? check Messages → Unknown Senders)
  Penny: hey, i'm penny. i keep an eye on the money
  Penny: [contact card: Penny Suitemates, +19195550102]
  Penny: beach trip's about $45, that's 21% of the $210 you have left this month. you're good

Sam → Sunny: is saturday ok with my classes too?
  Sunny: want dean to check saturday against your classes?

(11 minutes later)

Sam → Sunny: yes
  Sunny: yes to what? lol. beach is still on for saturday

Sam → Penny: is dean gonna text me?
  [gate] financial: governed G1: claimed Dean is texting; not dispatched
  Penny: want dean to jump in?

Sam → Penny: yes
  Penny: on it! Dean is texting you now from their own number (nothing showing? check Messages → Unknown Senders)
  Dean: hey, i'm dean. i keep track of school
  Dean: [contact card: Dean Suitemates, +19195550103]
  Dean: this week: comp 421 project 1 is due monday 9am

Sam → Sunny: ask dean if saturday is clear
  Sunny: dean's texting you now
  Dean: saturday's clear, no classes and nothing due that day
```

## Rules the engine owns
Each rule was a live failure first (HackNC 2026, the night of Oct 10–11). The constants live only in `src/handoff/state.ts`.

| Rule | Where | Test |
|---|---|---|
| One shot: a reply that isn't yes or no drops the offer | `engine.ts` answerOffer | "'no' drops the offer; anything that isn't yes or no also drops it" |
| An offer lives 10 minutes (`OFFER_TTL_MS`) | `state.ts` answersOffer | "an offer expires after OFFER_TTL…", "a 'yes' after the offer expired is just a message" |
| A yes in another hand-off agent's thread counts for 3 minutes (`PARTY_TTL_MS`) | `state.ts` answersOffer | "a 'yes' in another hand-off agent's thread only counts for a few minutes" |
| In another agent's thread only a plain yes accepts (`PLAIN_YES`) | `engine.ts` answerOffer | "in another agent's thread only a real yes counts, not 'ok'" |
| A yes that answers that agent's own question is not a yes to the offer | `engine.ts` answerOffer | "'yes option 1' to Dean (answering his own 'your call') goes to Dean" |
| Consent = a request phrase for the agent in the student's text (a negation vetoes it) AND `asked=true` | `handoff/tool.ts` | "asked=true is not consent unless the student named the agent", "consent needs a request for that agent…" |
| A bare yes to an agent that just answered is a duplicate (3 min); a new plan or named ask is not | `handoff/tool.ts` | "an agent that just answered a hand-off isn't run again…", "the cooldown only stops a duplicate…" |
| The cooldown is recorded only after a real answer | `handoff/run.ts` | "cooldown recorded only after a real answer" |
| "X is texting you" only if every X named was dispatched this turn (G1); the rewrite is a real offer | `governance.ts`, `engine.ts` | "G1: one sentence naming two agents…", "engine G1: …" (three), review3 "S1: …" (two), "P5: …", "S4: …" |

## Tests
`npm test` (51 tests, node:test) and `npm run typecheck`. They were written before the code in this repo
(`docs/evidence/handoff-red-before.txt`, then `handoff-green.txt`). Every hand-off and G1 test carries an `origin` comment pinning it to
a hackathon failure or review finding; the scripted-model tests are marked as a test double with no live failure behind them. Timing is an injected clock, never a sleep.

## Origin & credit
This is a narrow slice of [Suitemates](https://github.com/kerryshi/suitemates), built at HackNC 2026 with two
teammates who owned the Academic and Social agents. The hand-off protocol (`core/recruit.ts`) and the G1 gate were
Kerry's part; this repo carries only that part, re-cut from his lines (`docs/evidence/provenance-blame.txt` has the
`git blame -w` counts taken at hacknc-agents `2340aa2` before the cut). The engine is rewritten narrow; the personas
are new stand-ins.

## Not included
The real thing texted over iMessage: each agent had its own number (Photon/Spectrum), and a student was added to an
agent's number when it was brought in. Here the transport is a terminal and the add is injected (`EngineDeps.addUser`).
Also left in the hackathon repo: per-user memory, the emoji/voice cap, the watchdog, proactive texts, web sign-up,
and the real personas' data (Capital One Nessie, Canvas, Heel Life). `src/llm/gemini.ts` is the live client
(`GEMINI_API_KEY=... npm run chat`, default model `gemini-3.6-flash` as in the hackathon build); it needs a key and is not exercised in CI or the tests. The transcript above is scripted.

## AI tools
Built with **Claude Code** (Anthropic's coding agent): Kerry made the product calls (separate numbers, consent
before an agent texts, no group chat); Claude Code planned, wrote and tested the code, and a separate Claude reviewer
checked it. The runtime model in the hackathon build was the **Gemini API** (Flash).
