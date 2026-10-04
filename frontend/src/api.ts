import type { AgentResult, Permit } from "./types"

// Local backend by default. Set VITE_API_URL in frontend/.env when the backend is deployed.
// The backend must list this site in CORS_ORIGINS (backend/.env).
const BASE = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/$/, "")

export type AgentAction = {
  tool: string
  ok: boolean
  args?: Record<string, unknown>
  error?: string
}

export type ApiAgentResult = AgentResult & { actions: AgentAction[] }

export type ChatTurn = { role: "user" | "assistant"; content: string }

export async function fetchPermits(): Promise<Permit[]> {
  const response = await fetch(`${BASE}/api/permits`)
  if (!response.ok) throw new Error(`Backend returned ${response.status}`)
  return response.json()
}

type ListMetrics = { filesInList: number; homesInList: number; multifamilyFiles: number; needsReview: number }

export type Scoreboard = {
  capacity: number
  queueSize: number
  fifo: ListMetrics
  pilot: ListMetrics
  pilotCut: ListMetrics & { capacity: number; droppedIds: string[] }
}

export async function fetchScoreboard(): Promise<Scoreboard> {
  const response = await fetch(`${BASE}/api/scoreboard`)
  if (!response.ok) throw new Error(`Backend returned ${response.status}`)
  return response.json()
}

export async function askAgent(message: string, history: ChatTurn[]): Promise<ApiAgentResult> {
  const response = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  })
  // 503 = no OpenAI key, 502 = OpenAI error. The caller falls back to the local agent.
  if (!response.ok) throw new Error(`Agent returned ${response.status}`)
  return response.json()
}
