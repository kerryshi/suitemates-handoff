// One persona turn: system prompt + history + message → tool loop → reply text.
import type { Persona, ToolCtx } from "./types.ts";
import type { LlmClient, LlmMessage } from "./llm/client.ts";
import type { Turn } from "./store.ts";

const MAX_TOOL_ROUNDS = 3;
const TOOL_TIMEOUT_MS = 10_000;
const RECRUIT_HISTORY = 4; // turns a brought-in agent sees: enough not to repeat itself, not enough to re-answer old texts

// dm: the student texted this agent. recruit: another agent brought it in and it texts first.
export type Setting = "dm" | "recruit";

export interface RespondArgs {
  persona: Persona;
  ctx: ToolCtx;
  llm: LlmClient;
  history: Turn[];
  text: string;
  setting: Setting;
  product: string;
  names: Record<string, string>; // persona id → display name
}

export async function respond(a: RespondArgs): Promise<string> {
  const system = `${a.persona.prompt.trim()}\n\n${contextBlock(a)}`;
  const history = a.setting === "recruit" ? a.history.slice(-RECRUIT_HISTORY) : a.history;
  const messages: LlmMessage[] = [
    ...history.map(({ role, text }) => ({ role, text }) as LlmMessage),
    { role: "user", text: a.text },
  ];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const step = await a.llm.chat({ system, messages, tools: a.persona.tools });
    if ("text" in step) return step.text;
    messages.push({ role: "model", toolCalls: step.toolCalls, raw: step.raw });
    const results = [];
    for (const call of step.toolCalls) results.push({ name: call.name, result: await runTool(a.persona, call, a.ctx) });
    messages.push({ role: "tool", results });
  }
  // Out of tool rounds: answer from what the tools returned. Still nothing → throw, so the caller's fallback runs
  // (a retry, the glitch line) instead of the student getting the literal "(no reply)".
  const last = await a.llm.chat({ system, messages, tools: a.persona.tools, noTools: true });
  if ("text" in last && last.text.trim()) return last.text;
  throw new Error(`${a.persona.id}: model returned no text after ${MAX_TOOL_ROUNDS} tool rounds`);
}

async function runTool(persona: Persona, call: { name: string; args: Record<string, unknown> }, ctx: ToolCtx): Promise<string> {
  const tool = persona.tools.find((t) => t.name === call.name);
  if (!tool) return `error: no tool named ${call.name}`;
  ctx.log(`tool ${call.name}(${JSON.stringify(call.args)})`);
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("timed out")), TOOL_TIMEOUT_MS)));
    const out = await Promise.race([tool.run(call.args ?? {}, ctx), timeout]).finally(() => clearTimeout(timer));
    return typeof out === "string" ? out : JSON.stringify(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`tool ${call.name} failed: ${msg}`);
    return `error: ${msg}`;
  }
}

function contextBlock(a: RespondArgs): string {
  const me = a.names[a.persona.id];
  const others = Object.entries(a.names)
    .filter(([id]) => id !== a.persona.id)
    .map(([id, n]) => `${n} (${id})`)
    .join(" and ");
  const setting = {
    dm: "a 1:1 text conversation with the student.",
    recruit:
      "a text you are sending first, from your own number, because another agent just brought you in (the brief says why). " +
      "Your hello was already sent. Answer the question with your tools in one or two short lines.",
  }[a.setting];
  return [
    "## Context (written by core — do not repeat it back)",
    `- You are ${me}, one of three texting agents in ${a.product}, alongside ${others}.`,
    `- Setting: ${setting}`,
    `- Now: ${a.ctx.now.toLocaleString("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}.`,
    `- Student: ${a.ctx.user.name ?? "unknown name"}.`,
    "- Text like their friend, not a notification app: usually one short line (two max), lowercase, no markdown, no lists. End with a question only when you need an answer.",
    "- Get facts from your tools. Never invent numbers, dates, or names.",
  ].join("\n");
}
