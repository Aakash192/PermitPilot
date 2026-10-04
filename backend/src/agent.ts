import {
  chatResponseSchema,
  executeIntent,
  rulesIntent,
  type ChatResponse,
  type Intent,
  type Permit,
} from "@permit-pilot/core"
import { modelIntent } from "./model"

async function hostedResponse(message: string, fileId: string): Promise<ChatResponse | null> {
  const url = process.env.HOSTED_AGENT_URL
  if (!url) return null
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, fileId }),
  })
  if (!response.ok) throw new Error(`Hosted agent returned ${response.status}`)
  const parsed = chatResponseSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error("Hosted agent returned an unexpected shape.")
  return parsed.data
}

async function resolveIntent(message: string): Promise<Intent> {
  if (!process.env.OPENAI_API_KEY) return rulesIntent(message)
  try {
    return await modelIntent(message)
  } catch {
    return rulesIntent(message)
  }
}

export async function answer(message: string, fileId: string, permits: Permit[]): Promise<ChatResponse> {
  if (process.env.HOSTED_AGENT_URL) {
    try {
      const hosted = await hostedResponse(message, fileId)
      if (hosted) return hosted
    } catch {
      // The local ranker still answers so a bad hosted response does not blank the chat.
    }
  }
  const intent = await resolveIntent(message)
  return chatResponseSchema.parse(executeIntent(intent, permits))
}
