// Bringing agents in once the student said yes (or named them): add each under its own number, or fall back to the
// conversation the student is already in, name-tagged (Outbound.via, UserProfile.via); then each one's hello +
// card (if new) and its answer, all agents in parallel.
import type { Engine } from "../engine.ts";
import type { AddResult, Outbound, PersonaId } from "../types.ts";
import { handoffs, has, type Pending, type RecruitAsk } from "./state.ts";

// Returns the texts in send order.
export async function runRecruit(engine: Engine, phone: string, p: Pending): Promise<{ out: Outbound[]; viaFrom: PersonaId[] }> {
  const { store, names } = engine.d;
  const before = store.user(phone);
  const fresh = new Set(p.agents.filter((a) => !has(before, a.id)).map((a) => a.id));
  const added = await Promise.all(
    p.agents.map(async (a): Promise<AddResult | undefined> => (fresh.has(a.id) && engine.needsAdd(a.id, before) ? engine.addFor(a.id, before) : undefined)),
  );
  // One synchronous update of the profile after every add has settled (parallel saves would clobber each other).
  const u = store.user(phone);
  const poolLines = { ...u.poolLines };
  const via = { ...u.via };
  const viaFrom: PersonaId[] = [];
  p.agents.forEach((a, i) => {
    const r = added[i];
    if (!r) return;
    if (r.ok) {
      if (r.line) poolLines[engine.projectFor(a.id)] = r.line;
      delete via[a.id];
    } else {
      engine.log(`[add] ${a.id}: ${r.error ?? "add failed"}; ${names[a.id]} speaks through ${names[p.from]}`);
      via[a.id] = p.from;
      viaFrom.push(a.id);
    }
  });
  // Someone who texted in has no agents list yet: it starts with the agent they were texting.
  const ids = [...(u.agents ? [] : [p.from]), ...p.agents.map((a) => a.id)];
  store.saveUser({
    ...u,
    agents: [...new Set([...(u.agents ?? []), ...ids])],
    greeted: [...new Set([...(u.greeted ?? []), ...ids])],
    poolLines,
    via,
  });
  const user = store.user(phone);
  const textsFor = async (a: RecruitAsk): Promise<Outbound[]> => {
    const hello = fresh.has(a.id) ? engine.hello(a.id, phone) : [];
    const n = names[p.from];
    const brief =
      `[handoff from ${n}] The student told ${n}: "${p.text}". ${n} brought you in to: ${a.ask}. ` +
      (fresh.has(a.id) ? "They said yes, and your hello and contact card were just sent: don't introduce yourself again. " : "") +
      "Answer it with your tools, in one or two short texts' worth.";
    // A new agent's first real text: retried once (Gemini sometimes returns nothing after a tool call), and never
    // replaced by the "my brain glitched" line; the hello and card already went out.
    let answer: string | undefined;
    for (let attempt = 1; attempt <= 2 && answer === undefined; attempt++) {
      try {
        answer = await engine.replyOrThrow(a.id, user, brief, "recruit", { party: p.agents.map((x) => x.id), said: p.text });
      } catch (err) {
        engine.log(`WARN ${a.id} handoff answer failed (try ${attempt}): ${err instanceof Error ? err.message : err}`);
      }
    }
    // Recorded only once the agent actually answered: a failed answer must not read as "already answered".
    if (answer) store.kv("shared", phone).set("handoffs", { ...handoffs(store, phone), [a.id]: engine.time() });
    const route = user.via?.[a.id];
    const said: Outbound[] = answer ? [{ persona: a.id, handle: `dm:${phone}`, text: answer }] : [];
    // Through another agent's thread: no contact card (it would carry that agent's number under this one's name,
    // and iOS would label the borrowed thread with either).
    return [...hello, ...said].filter((o) => !(route && o.card)).map((o): Outbound => (route ? { ...o, via: route } : o));
  };
  // With a live transport (engine.d.deliver), each agent's texts go out the moment that agent is ready, so the ack
  // isn't held back by the slowest agent's model calls. Without one (tests, the demo), they come back with the turn.
  const deliver = engine.d.deliver;
  if (deliver) {
    for (const a of p.agents) {
      engine.track(
        textsFor(a)
          .then((outs) => deliver(outs))
          .catch((err) => engine.log(`ERROR ${a.id} handoff texts failed: ${err instanceof Error ? err.message : err}`)),
      );
    }
    return { out: [], viaFrom };
  }
  return { out: (await Promise.all(p.agents.map(textsFor))).flat(), viaFrom };
}

// The offering agent's "on it", sent before the others' texts land. Only an agent with its own number texts from it;
// otherwise (or via) it jumps in here, name-tagged.
// viaThread: the offerer, when the yes came in another agent's thread: a fallback agent speaks in the offerer's thread.
export function ackText(
  names: Record<PersonaId, string>,
  ids: PersonaId[],
  viaFrom: PersonaId[],
  ownNumber: (id: PersonaId) => boolean,
  viaThread?: PersonaId,
): string {
  const own = ids.filter((id) => !viaFrom.includes(id) && ownNumber(id)).map((id) => names[id]);
  const there = viaThread ? ids.filter((id) => viaFrom.includes(id)).map((id) => names[id]) : [];
  const here = ids.filter((id) => (viaFrom.includes(id) && !viaThread) || (!viaFrom.includes(id) && !ownNumber(id))).map((id) => names[id]);
  const and = (xs: string[]) => xs.join(" and ");
  const parts = [
    own.length ? `${and(own)} ${own.length > 1 ? "are" : "is"} texting you now from ${own.length > 1 ? "their own numbers" : "their own number"}` : "",
    here.length ? `${and(here)} ${here.length > 1 ? "are" : "is"} jumping in right here` : "",
    there.length ? `${and(there)} ${there.length > 1 ? "are" : "is"} jumping in over in ${names[viaThread!]}'s thread` : "",
  ].filter(Boolean);
  const filter = own.length ? " (nothing showing? check Messages → Unknown Senders)" : "";
  return `on it! ${parts.join(", and ")}${filter}`;
}
