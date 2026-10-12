// The three agents, by id.
import type { Persona, PersonaId } from "../src/types.ts";
import sunny from "./sunny/index.ts";
import penny from "./penny/index.ts";
import dean from "./dean/index.ts";

export function loadPersonas(): Map<PersonaId, Persona> {
  return new Map([sunny, penny, dean].map((p) => [p.id, p]));
}
