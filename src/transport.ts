// Where texts go in and out. The hackathon build sent iMessages (one number per agent); here, a terminal.
import { createInterface } from "node:readline";
import type { Inbound, Outbound, PersonaId } from "./types.ts";

export interface Transport {
  start(onInbound: (ev: Inbound) => Promise<void>): Promise<void>;
  send(o: Outbound): Promise<void>;
}

// Each line typed is a text to `persona` from `phone`; each text out is printed with who sent it.
export class ConsoleTransport implements Transport {
  private readonly names: Record<PersonaId, string>;
  private readonly persona: PersonaId;
  private readonly phone: string;
  private readonly write: (line: string) => void;

  constructor(o: { names: Record<PersonaId, string>; persona: PersonaId; phone: string; write?: (line: string) => void }) {
    this.names = o.names;
    this.persona = o.persona;
    this.phone = o.phone;
    this.write = o.write ?? ((line) => console.log(line));
  }

  async start(onInbound: (ev: Inbound) => Promise<void>): Promise<void> {
    const rl = createInterface({ input: process.stdin });
    let n = 0;
    for await (const text of rl) {
      if (text.trim()) await onInbound({ persona: this.persona, sender: this.phone, text, handle: `${this.persona}-thread`, messageId: `c${++n}`, lineKnown: true });
    }
  }

  async send(o: Outbound): Promise<void> {
    this.write(format(o, this.names));
  }
}

export function format(o: Outbound, names: Record<PersonaId, string>): string {
  const who = o.via ? `${names[o.via]} (as ${names[o.persona]})` : names[o.persona];
  const body = o.card ? `[contact card: ${o.card.name}${o.card.phone ? `, ${o.card.phone}` : ""}]` : o.text;
  return `  ${who}: ${body}`;
}

// One failed send never drops the rest of the batch.
export async function sendAll(t: Transport, outs: Outbound[], log: (msg: string) => void = console.error): Promise<void> {
  for (const o of outs) {
    try {
      await t.send(o);
    } catch (err) {
      log(`[send] ${o.persona}${o.via ? ` via ${o.via}` : ""} ${o.handle} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
