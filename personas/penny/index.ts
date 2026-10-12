// Penny (financial). One fixed tool: the hand-off is the point of this repo, not the data behind it.
import { readFileSync } from "node:fs";
import type { Persona } from "../../src/types.ts";

const penny: Persona = {
  id: "financial",
  prompt: readFileSync(new URL("./prompt.md", import.meta.url), "utf8"),
  hello: "hey, i'm penny. i keep an eye on the money",
  tools: [
    {
      name: "check_budget",
      description: "Their spending budget: what's left this month and what a plan would cost.",
      parameters: { properties: {} },
      run: async () => "Budget left this month: $210. Beach trip estimate: $45 (21% of what's left). Sample data.",
    },
  ],
};

export default penny;
