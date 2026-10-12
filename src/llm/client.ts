// The one LLM interface. Gemini for a live run, a scripted model (src/llm/scripted.ts) for tests and the demo.
import type { Tool } from "../types.ts";

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type LlmMessage =
  | { role: "user"; text: string }
  | { role: "model"; text: string }
  // `raw` = the provider's own parts, echoed back verbatim (Gemini needs its thought signatures)
  | { role: "model"; toolCalls: ToolCall[]; raw?: unknown[] }
  | { role: "tool"; results: { name: string; result: string }[] };

export type LlmStep = { text: string } | { toolCalls: ToolCall[]; raw?: unknown[] };

export interface LlmClient {
  readonly name: string;
  // noTools: out of tool rounds; the model must answer in text from the tool results already in `messages`.
  chat(req: { system: string; messages: LlmMessage[]; tools: Tool[]; noTools?: boolean }): Promise<LlmStep>;
  // JSON-mode completion; returns the raw JSON text.
  json(req: { system: string; text: string }): Promise<string>;
}
