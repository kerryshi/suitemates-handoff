// Gemini generateContent over REST with function calling. No SDK: one fetch per step.
import type { Tool } from "../types.ts";
import type { LlmClient, LlmMessage, LlmStep } from "./client.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 25_000;

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
  [k: string]: unknown;
}

export class GeminiClient implements LlmClient {
  readonly name: string;
  private readonly key: string;
  readonly model: string;

  constructor(key: string, model: string) {
    this.key = key;
    this.model = model;
    this.name = `gemini:${model}`;
  }

  async chat(req: { system: string; messages: LlmMessage[]; tools: Tool[]; noTools?: boolean }): Promise<LlmStep> {
    if (req.noTools) return this.answerNow(req.system, req.messages);
    const parts = await this.generate({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map(toContent),
      ...(req.tools.length ? { tools: [{ functionDeclarations: req.tools.map(declare) }] } : {}),
    });
    const calls = parts.filter((p) => p.functionCall);
    if (calls.length) {
      return { toolCalls: calls.map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {} })), raw: parts };
    }
    const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
    if (!text) throw new Error(`Gemini ${this.model} returned no text`);
    return { text };
  }

  // Out of tool rounds: a text answer from what the tools returned. Gemini ignores functionCallingConfig NONE (live,
  // 02:25: it answered with invented tools, which core used to send as "(no reply)"), so the tool calls and results
  // are flattened to plain text, no tools are declared, the instruction is explicit, and any stray call is ignored.
  private async answerNow(system: string, messages: LlmMessage[]): Promise<LlmStep> {
    const contents: { role: string; parts: { text: string }[] }[] = [];
    const add = (role: string, text: string) => {
      const prev = contents.at(-1);
      if (prev?.role === role) prev.parts.push({ text });
      else contents.push({ role, parts: [{ text }] });
    };
    for (const m of messages) {
      if (m.role === "user") add("user", m.text);
      else if (m.role === "tool") add("user", `Tool results:\n${m.results.map((r) => `- ${r.name} → ${r.result}`).join("\n")}`);
      else if ("toolCalls" in m) add("model", `(looked up: ${m.toolCalls.map((c) => c.name).join(", ")})`);
      else add("model", m.text);
    }
    add("user", "Now answer the student from these results in plain text. Do not call any tools.");
    const parts = await this.generate({ systemInstruction: { parts: [{ text: system }] }, contents });
    const text = parts.filter((p) => !p.thought && !p.functionCall).map((p) => p.text ?? "").join("").trim();
    if (!text) throw new Error(`Gemini ${this.model} returned no text (answer-now step)`);
    return { text };
  }

  async json(req: { system: string; text: string }): Promise<string> {
    const parts = await this.generate({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.text }] }],
      generationConfig: { responseMimeType: "application/json" },
    });
    return parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  }

  private async generate(body: unknown): Promise<Part[]> {
    const res = await fetch(`${BASE}/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Gemini ${this.model} → ${res.status}: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw) as { candidates?: { content?: { parts?: Part[] } }[] };
    return json.candidates?.[0]?.content?.parts ?? [];
  }
}

function toContent(m: LlmMessage) {
  switch (m.role) {
    case "user":
      return { role: "user", parts: [{ text: m.text }] };
    case "model":
      if ("toolCalls" in m) {
        return { role: "model", parts: m.raw ?? m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) };
      }
      return { role: "model", parts: [{ text: m.text }] };
    case "tool":
      return {
        role: "user",
        parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.result } } })),
      };
  }
}

function declare(t: Tool) {
  const properties: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(t.parameters.properties)) {
    properties[k] = { type: p.type.toUpperCase(), description: p.description, ...(p.enum ? { enum: p.enum } : {}) };
  }
  return {
    name: t.name,
    description: t.description,
    parameters: { type: "OBJECT", properties, ...(t.parameters.required?.length ? { required: t.parameters.required } : {}) },
  };
}
