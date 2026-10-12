// Sunny (social). One fixed tool: the hand-off is the point of this repo, not the data behind it.
import { readFileSync } from "node:fs";
import type { Persona } from "../../src/types.ts";

const sunny: Persona = {
  id: "social",
  prompt: readFileSync(new URL("./prompt.md", import.meta.url), "utf8"),
  hello: "hey, i'm sunny! i find the plans",
  tools: [
    {
      name: "find_plans",
      description: "What's happening this week: outings, trips and events with day, time and rough cost.",
      parameters: { properties: {} },
      run: async () => "Beach trip to Wrightsville, Saturday 9 AM, about $45 a person (gas split + food). Sample data.",
    },
  ],
};

export default sunny;
