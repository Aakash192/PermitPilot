export type Permit = {
  id: string
  address: string
  category: string
  description: string
  status: string
  applied: string
  community: string
  ward: string
  quadrant: string
  sector: string
  srg: string
  lat: number
  lng: number
  homes: number
  stated: boolean
  basis: string
  ageDays: number | null
}

export type PickRow = {
  id: string
  homes: number
  stated: boolean
  address: string
  community: string
  status: string
}

export type AgentMode = "filter" | "reset" | "clarify"

export type AgentResult = {
  mode: AgentMode
  reply: string
  ids: string[]
  picks: PickRow[]
}
