import { openai } from "@ai-sdk/openai"
import { intentSchema, type Intent } from "@permit-pilot/core"
import { generateObject, jsonSchema } from "ai"

const intentJson = jsonSchema<Intent>({
  type: "object",
  additionalProperties: false,
  required: ["type", "reply", "openOnly", "limit", "sort", "quadrant", "ward", "community"],
  properties: {
    type: { type: "string", enum: ["explain", "reset", "query"] },
    reply: { type: "string" },
    openOnly: { type: "boolean" },
    limit: { type: ["number", "null"] },
    sort: { type: "string", enum: ["review", "oldest", "newest", "homes"] },
    quadrant: { anyOf: [{ type: "string", enum: ["SW", "NW", "NE", "SE"] }, { type: "null" }] },
    ward: { type: ["string", "null"] },
    community: { type: ["string", "null"] },
  },
})

const instructions = `You classify one message from a city planner looking at housing development permits.
Return only the schema.
Use type "explain" when the answer is a definition or a question and the map should stay as it is. Put that answer in reply.
Use type "reset" when they want every permit on the map again.
Use type "query" when they want a list. Set openOnly when they mean files still in the queue.
sort "review" means this week's review list: days past the target, multi-family first.
sort "oldest", "newest", or "homes" when they ask for that instead.
limit is the number of files they asked for, otherwise null.
quadrant is SW, NW, NE, or SE when they name one, otherwise null.
ward is the ward number as text, otherwise null.
community is a neighbourhood name when they name one, otherwise null.
Do not invent permit numbers.`

export async function modelIntent(message: string): Promise<Intent> {
  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    schema: intentJson,
    prompt: `${instructions}\n\nPlanner: ${message}`,
  })
  return intentSchema.parse(object)
}
