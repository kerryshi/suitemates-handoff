// `npm run chat`: text Sunny from the terminal through the real engine. With GEMINI_API_KEY set the agents are Gemini
// (GEMINI_MODEL picks the model; default gemini-3.6-flash, the hackathon build's); without it, a short scripted model covers the beach-trip hand-off and anything
// off-script gets the engine's fallback line, not an invented answer. Texts the agents send are printed with who sent them.
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { GeminiClient } from "../src/llm/gemini.ts";
import { ScriptedLlm } from "../src/llm/scripted.ts";
import { ConsoleTransport, sendAll } from "../src/transport.ts";
import { loadPersonas } from "../personas/index.ts";
import type { LlmClient } from "../src/llm/client.ts";
import type { PersonaId } from "../src/types.ts";

const NAMES: Record<PersonaId, string> = { social: "Sunny", financial: "Penny", academic: "Dean" };
const PHONE = "+19195550100";
const LINES: Record<PersonaId, string> = { social: "+19195550101", financial: "+19195550102", academic: "+19195550103" };

const key = process.env.GEMINI_API_KEY;
const llm: LlmClient = key
  ? new GeminiClient(key, process.env.GEMINI_MODEL ?? "gemini-3.6-flash")
  : new ScriptedLlm(NAMES, [
      { persona: "social", when: /beach/i, then: { toolCalls: [{ name: "find_plans", args: {} }, { name: "bring_in", args: { agent: "financial", ask: "price the beach trip" } }] } },
      { persona: "social", when: "tool", then: { text: "wrightsville beach, sat 9am, about $45 a person. want penny to check that against your budget?" } },
      { persona: "financial", when: /^\[handoff/, then: { toolCalls: [{ name: "check_budget", args: {} }] } },
      { persona: "financial", when: "tool", then: { text: "beach trip's about $45, that's 21% of the $210 you have left this month. you're good" } },
    ]);

const store = new Store(null);
const transport = new ConsoleTransport({ names: NAMES, persona: "social", phone: PHONE });
const engine = new Engine({
  personas: loadPersonas(),
  store,
  llm,
  names: NAMES,
  product: "Suitemates",
  log: (m) => console.error(`  [engine] ${m}`),
  ownNumber: () => true,
  addUser: async (_phone, _name, id) => ({ ok: true, line: LINES[id] }),
  deliver: (outs) => sendAll(transport, outs),
});
store.saveUser({ phone: PHONE, name: "Sam", agents: ["social"], greeted: ["social"], poolLines: { social: LINES.social } });

console.error(`chat with Sunny (${llm.name}). ${key ? "" : "No GEMINI_API_KEY: scripted; try \"beach trip saturday?\" then \"yes\". "}Ctrl-D to quit.`);
await transport.start(async (ev) => sendAll(transport, await engine.handle(ev)));
// stdin closed: let any recruited agent's texts still in flight print before exiting.
await engine.settled();
