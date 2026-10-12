// `npm run demo`: seven texts through the real engine, state machine and G1 gate, with a scripted model (no API key).
// The model's lines are fixed below; everything else in the transcript (who answers, the ack, hello + card, what
// is dropped, what is rewritten) is decided by src/. The run fails if the engine calls the model off-script.
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { ScriptedLlm } from "../src/llm/scripted.ts";
import { format } from "../src/transport.ts";
import { loadPersonas } from "../personas/index.ts";
import type { PersonaId } from "../src/types.ts";

const NAMES: Record<PersonaId, string> = { social: "Sunny", financial: "Penny", academic: "Dean" };
const PHONE = "+19195550100";
const LINES: Record<PersonaId, string> = { social: "+19195550101", financial: "+19195550102", academic: "+19195550103" };
const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args });

const llm = new ScriptedLlm(NAMES, [
  // 1. A plan that costs money: Sunny looks it up and offers Penny (the tool says "not sent yet, ask").
  { persona: "social", when: /beach/, then: { toolCalls: [call("find_plans"), call("bring_in", { agent: "financial", ask: "price the beach trip against their budget" })] } },
  { persona: "social", when: "tool", then: { text: "wrightsville beach, sat 9am, about $45 a person. want penny to check that against your budget?" } },
  // 2. Penny, brought in, answers from her own tool.
  { persona: "financial", when: /^\[handoff/, then: { toolCalls: [call("check_budget")] } },
  { persona: "financial", when: "tool", then: { text: "beach trip's about $45, that's 21% of the $210 you have left this month. you're good" } },
  // 3. Sunny offers Dean...
  { persona: "social", when: /classes/, then: { toolCalls: [call("bring_in", { agent: "academic", ask: "check saturday against their classes" })] } },
  { persona: "social", when: "tool", then: { text: "want dean to check saturday against your classes?" } },
  // 4. ...but the yes comes 11 minutes later: the offer has expired, so it's just a text to Sunny.
  { persona: "social", when: /^yes$/, then: { text: "yes to what? lol. beach is still on for saturday" } },
  // 5. Penny claims Dean is texting. Nothing was dispatched: G1 rewrites it.
  { persona: "financial", when: /dean/, then: { text: "dean's texting you now!" } },
  // 6. The rewrite is a real offer from Penny: a plain yes in her thread brings Dean in, hello + card + answer.
  { persona: "academic", when: /^\[handoff/, then: { toolCalls: [call("check_week")] } },
  { persona: "academic", when: "tool", then: { text: "this week: comp 421 project 1 is due monday 9am" } },
  // 7. Naming Dean is consent: he answers in the same turn (no second hello), and Sunny's true claim passes G1 untouched.
  { persona: "social", when: /ask dean/, then: { toolCalls: [call("bring_in", { agent: "academic", ask: "is saturday clear", asked: true })] } },
  { persona: "social", when: "tool", then: { text: "dean's texting you now" } },
  { persona: "academic", when: /^\[handoff/, then: { toolCalls: [call("check_week")] } },
  { persona: "academic", when: "tool", then: { text: "saturday's clear, no classes and nothing due that day" } },
]);

let t = Date.UTC(2026, 9, 11, 22, 0);
const lines: string[] = [];
const say = (line: string) => lines.push(line);
const store = new Store(null);
const engine = new Engine({
  personas: loadPersonas(),
  store,
  llm,
  names: NAMES,
  product: "Suitemates",
  now: () => t,
  log: (m) => (m.includes("governed") ? say(`  [gate] ${m}`) : undefined),
  ownNumber: () => true,
  addUser: async (_phone, _name, id) => ({ ok: true, line: LINES[id] }),
});
// Sam has Sunny on their phone; Penny and Dean are brought in.
store.saveUser({ phone: PHONE, name: "Sam", agents: ["social"], greeted: ["social"], poolLines: { social: LINES.social } });

let n = 0;
async function text(to: PersonaId, body: string) {
  say(`Sam → ${NAMES[to]}: ${body}`);
  const outs = await engine.handle({ persona: to, sender: PHONE, text: body, handle: `${to}-thread`, messageId: `d${++n}`, lineKnown: true });
  for (const o of outs) say(format(o, NAMES));
  say("");
}

await text("social", "beach trip saturday, can i afford it?");
await text("social", "yes");
await text("social", "is saturday ok with my classes too?");
t += 11 * 60_000;
say("(11 minutes later)");
say("");
await text("social", "yes");
await text("financial", "is dean gonna text me?");
await text("financial", "yes");
await text("social", "ask dean if saturday is clear");

process.stdout.write(lines.join("\n").trimEnd() + "\n");
if (llm.remaining()) {
  console.error(`demo: ${llm.remaining()} scripted model step(s) never used`);
  process.exit(1);
}
