// A model that follows a script: tests and the demo run with no API key and no improvising. Each rule names who is
// speaking (optional), what it answers (a pattern on the student's/brief's text, or 'tool' for a tool result), and
// the step to return. The first unused rule that matches is used once. Anything off-script throws: a demo that
// silently made something up would prove nothing.
import type { PersonaId, Tool } from "../types.ts";
import type { LlmClient, LlmMessage, LlmStep } from "./client.ts";

export interface ScriptRule {
  persona?: PersonaId;
  when: RegExp | "tool";
  then: LlmStep;
}

export class ScriptedLlm implements LlmClient {
  readonly name = "scripted";
  private readonly rules: ScriptRule[];
  private readonly names: Record<PersonaId, string>;

  constructor(names: Record<PersonaId, string>, rules: ScriptRule[]) {
    this.names = names;
    this.rules = [...rules];
  }

  remaining(): number {
    return this.rules.length;
  }

  async chat(req: { system: string; messages: LlmMessage[]; tools: Tool[]; noTools?: boolean }): Promise<LlmStep> {
    const last = req.messages.at(-1);
    const speaker = (Object.keys(this.names) as PersonaId[]).find((id) => req.system.includes(`You are ${this.names[id]},`));
    const i = this.rules.findIndex(
      (r) =>
        (!r.persona || r.persona === speaker) &&
        (r.when === "tool" ? last?.role === "tool" : last?.role === "user" && r.when.test(last.text)),
    );
    if (i < 0) {
      const what = last?.role === "user" ? JSON.stringify(last.text.slice(0, 80)) : last?.role ?? "nothing";
      throw new Error(`ScriptedLlm: unexpected call (${speaker ?? "unknown speaker"} on ${what})`);
    }
    return this.rules.splice(i, 1)[0].then;
  }

  async json(): Promise<string> {
    throw new Error("ScriptedLlm: unexpected call (json)");
  }
}
