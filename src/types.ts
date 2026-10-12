// The narrow contract: three agents, one student profile, the tools a model may call, and the texts in and out.
export type PersonaId = "academic" | "financial" | "social";
export const PERSONA_IDS: PersonaId[] = ["academic", "financial", "social"];

export interface UserProfile {
  phone: string; // E.164: the student's id everywhere
  name?: string;
  agents?: PersonaId[]; // agents on their phone; unset = texted in directly, nobody brought in yet
  greeted?: PersonaId[]; // agents that already sent their hello + contact card
  lastAgent?: PersonaId; // who answered their last text (a shared number replies from them by default)
  // Each agent texts from its own number: project → the number this person texts there. Keyed by project, so a
  // changed project means "not added there yet".
  poolLines?: Record<string, string>;
  // An agent that couldn't be added under its own number speaks through the agent they were already texting:
  // agent → the agent whose conversation it borrows (src/handoff/run.ts).
  via?: Partial<Record<PersonaId, PersonaId>>;
}

// What every tool receives.
export interface ToolCtx {
  user: UserProfile;
  now: Date;
  log: (msg: string) => void;
}

export interface ToolParam {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: string[];
}

// A function the model can call.
export interface Tool {
  name: string;
  description: string; // the model reads this to decide WHEN to call it: be specific
  parameters: { properties: Record<string, ToolParam>; required?: string[] };
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

export interface Persona {
  id: PersonaId;
  prompt: string; // contents of prompt.md: voice + rules
  hello: string; // the first text it sends someone it was just brought in to
  tools: Tool[];
}

export interface Inbound {
  persona: PersonaId; // whose number received it
  sender: string; // the student's phone
  text?: string;
  handle: string; // conversation id on that persona's line
  messageId: string;
  // true when the number they texted belongs to `persona` alone. Unset on a shared number: the engine picks.
  lineKnown?: boolean;
}

export interface Outbound {
  persona: PersonaId; // send FROM this persona's number
  handle: string; // conversation id on that line, or "dm:<phone>" to start one
  text: string;
  card?: { name: string; phone?: string }; // a contact card sent after `text` (which may be "")
  // Send through THIS persona's conversation instead, name-tagged as `persona` (UserProfile.via).
  via?: PersonaId;
}

// Putting a student on an agent's own number (in the hackathon: an allowlist add through the messaging provider's CLI, seconds long).
export interface AddResult {
  ok: boolean;
  line?: string; // the number this person texts on that agent's project
  error?: string;
}
export type AddUser = (phone: string, firstName: string, agent: PersonaId) => Promise<AddResult>;
