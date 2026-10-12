// State in one JSON file, or in memory (file = null: tests, the demo). Tiny on purpose: a handful of users.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PersonaId, UserProfile } from "./types.ts";

export interface Turn {
  role: "user" | "model";
  text: string;
}

interface State {
  users: Record<string, UserProfile>;
  history: Record<string, Turn[]>; // "<persona>:<phone>"
  seen: Record<string, number>; // claimed keys → epoch ms
  kv: Record<string, Record<string, unknown>>; // "<persona|shared>:<phone>"
}

const HISTORY_TURNS = 12;

export class Store {
  private state: State = { users: {}, history: {}, seen: {}, kv: {} };
  private readonly file: string | null;

  constructor(file: string | null) {
    this.file = file;
    if (file && existsSync(file)) this.state = { ...this.state, ...JSON.parse(readFileSync(file, "utf8")) };
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  user(phone: string): UserProfile {
    return (this.state.users[phone] ??= { phone });
  }

  saveUser(u: UserProfile) {
    this.state.users[u.phone] = u;
    this.save();
  }

  history(persona: PersonaId, phone: string): Turn[] {
    return this.state.history[`${persona}:${phone}`] ?? [];
  }

  pushHistory(persona: PersonaId, phone: string, ...turns: Turn[]) {
    const key = `${persona}:${phone}`;
    this.state.history[key] = [...(this.state.history[key] ?? []), ...turns].slice(-HISTORY_TURNS);
    this.save();
  }

  // true the first time a key is claimed, false after. The clock is the caller's, so tests and the demo replay.
  claim(key: string, now: number): boolean {
    if (this.state.seen[key]) return false;
    this.state.seen[key] = now;
    this.save();
    return true;
  }

  kv(ns: PersonaId | "shared", phone: string) {
    const key = `${ns}:${phone}`;
    return {
      get: <T>(k: string) => this.state.kv[key]?.[k] as T | undefined,
      set: (k: string, v: unknown) => {
        (this.state.kv[key] ??= {})[k] = v;
        this.save();
      },
    };
  }
}
