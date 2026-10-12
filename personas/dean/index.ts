// Dean (academic). One fixed tool: the hand-off is the point of this repo, not the data behind it.
import { readFileSync } from "node:fs";
import type { Persona } from "../../src/types.ts";

const dean: Persona = {
  id: "academic",
  prompt: readFileSync(new URL("./prompt.md", import.meta.url), "utf8"),
  hello: "hey, i'm dean. i keep track of school",
  tools: [
    {
      name: "check_week",
      description: "What's due and what exams are coming this week, by day.",
      parameters: { properties: {} },
      run: async () => "Saturday: nothing due. Monday 9 AM: COMP 421 project 1. Sample data.",
    },
  ],
};

export default dean;
