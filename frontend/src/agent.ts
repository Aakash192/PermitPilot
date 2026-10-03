import { isOpenStatus } from "./parsePermits"
import type { AgentResult, Permit, PickRow } from "./types"

const EXAMPLE_HINT =
  "Sort the 50 files in SW Calgary by the maximum housing numbers so more homes can be reviewed first in that region."

type Plan = {
  quadrant?: string
  community?: string
  ward?: string
  sector?: string
  srg?: string
  category?: "multi" | "suite" | "single"
  status?: string
  openOnly?: boolean
  sort?: "homes" | "age"
  dir: "asc" | "desc"
  limit?: number
}

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b[\w']/g, (letter) => letter.toUpperCase())
}

function findLimit(text: string): number | undefined {
  const patterns = [
    /\b(?:top|first|next)\s+(\d{1,4})\b/i,
    /\b(\d{1,4})\s+(?:\w+\s+){0,3}(?:files|permits|applications|markers|projects|records)\b/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match) continue
    const count = Number(match[1])
    if (count >= 1 && count <= 5000) return count
  }
  return undefined
}

function findQuadrant(text: string): string | undefined {
  if (/\b(sw|southwest|south\s*-?\s*west)\b/.test(text)) return "SW"
  if (/\b(nw|northwest|north\s*-?\s*west)\b/.test(text)) return "NW"
  if (/\b(se|southeast|south\s*-?\s*east)\b/.test(text)) return "SE"
  if (/\b(ne|northeast|north\s*-?\s*east)\b/.test(text)) return "NE"
  return undefined
}

function findCommunity(text: string, permits: Permit[]): string | undefined {
  const names = [...new Set(permits.map((permit) => permit.community.trim()).filter((name) => name.length >= 4))]
  names.sort((a, b) => b.length - a.length)
  for (const name of names) {
    const pattern = new RegExp(`\\b${escapeReg(name.toLowerCase())}\\b`, "i")
    if (pattern.test(text)) return name
  }

  const stop = new Set([
    "calgary",
    "files",
    "homes",
    "houses",
    "housing",
    "review",
    "reviewed",
    "maximum",
    "numbers",
    "region",
    "queue",
    "permits",
    "applications",
    "sort",
    "basis",
    "quickly",
    "specific",
    "southwest",
    "northwest",
    "southeast",
    "northeast",
    "established",
    "developing",
    "family",
    "multi",
    "single",
    "secondary",
    "building",
    "buildings",
    "homes",
    "first",
    "where",
    "which",
    "these",
    "those",
    "about",
    "their",
  ])
  const tokens = text.match(/[a-z]{5,}/g) ?? []
  for (const token of tokens) {
    if (stop.has(token)) continue
    const hits = names.filter((name) => name.toLowerCase().includes(token))
    if (hits.length === 1) return hits[0]
  }
  return undefined
}

function matchesCategory(permit: Permit, category: Plan["category"]): boolean {
  const blob = `${permit.category} ${permit.description}`.toLowerCase()
  if (category === "multi") {
    return /multi-family|multi family|multi-residential|rowhouse|row house/.test(blob)
  }
  if (category === "suite") return /suite|secondary/.test(blob)
  if (category === "single") return /single|semi|duplex|contextual/.test(blob)
  return true
}

function planQuery(prompt: string, permits: Permit[]): Plan | "reset" | "clarify" {
  const text = prompt.toLowerCase().replace(/\s+/g, " ").trim()
  if (!text) return "clarify"
  if (/^(reset|clear|show all|all permits|everything)\b/.test(text) || /\b(show all|show everything|reset the map|clear the filter|clear filters)\b/.test(text)) {
    return "reset"
  }

  const includeClosed = /\b(including released|include released|all statuses|released too)\b/.test(text)
  const aboutReview = /\breview|\bqueue\b|\bpending\b|\bstill open\b|\bopen\b/.test(text)
  const fewest = /\b(fewest|least|smallest|minimum|lowest)\b/.test(text)
  const wantsOld = /\b(oldest|longest waiting|waiting the longest|fifo|oldest first)\b/.test(text)
  const wantsNew = /\b(newest|most recent|latest applications|latest files)\b/.test(text)
  const wantsHomes = /\b(homes|houses|housing|units|dwellings)\b/.test(text)

  const plan: Plan = { dir: fewest ? "asc" : "desc" }
  plan.quadrant = findQuadrant(text)
  plan.community = findCommunity(text, permits)
  plan.limit = findLimit(prompt)
  plan.ward = text.match(/\bward\s*(\d{1,2})\b/)?.[1]

  if (/\b(downtown|city centre|city center)\b/.test(text)) plan.sector = "CENTRE"
  if (/\bestablished\b/.test(text)) plan.srg = "ESTABLISHED"
  if (/\bdeveloping\b/.test(text)) plan.srg = "DEVELOPING"

  if (/\bmulti[-\s]?family\b|\bmulti[-\s]?residential\b|\browhouses?\b|\bapartments?\b/.test(text)) {
    plan.category = "multi"
  } else if (/\bsecondary suites?\b|\bsuites?\b/.test(text)) {
    plan.category = "suite"
  } else if (/\bduplex(?:es)?\b|\bsemi[-\s]?detached\b|\bsingle[-\s]?detached\b|\bcontextual\b/.test(text)) {
    plan.category = "single"
  }

  if (/pending release/.test(text)) plan.status = "pending release"
  else if (/in advertising/.test(text)) plan.status = "in advertising"
  else if (/under review/.test(text)) plan.status = "under review"
  else if (/in circulation/.test(text)) plan.status = "in circulation"
  else if (/pending decision/.test(text)) plan.status = "pending decision"
  else if (/\bon hold\b/.test(text)) plan.status = "hold"
  else if (/\breleased\b/.test(text)) plan.status = "released"

  if (aboutReview && !includeClosed && plan.status == null) plan.openOnly = true

  if (wantsOld) plan.sort = "age"
  else if (wantsNew) {
    plan.sort = "age"
    plan.dir = "asc"
  } else if (wantsHomes) plan.sort = "homes"
  else if (/\bsort\b|\brank\b|\bpriorit/.test(text)) plan.sort = "age"

  const hasFilter = Boolean(
    plan.quadrant ||
      plan.community ||
      plan.ward ||
      plan.sector ||
      plan.srg ||
      plan.category ||
      plan.status ||
      plan.openOnly ||
      plan.sort ||
      plan.limit,
  )
  return hasFilter ? plan : "clarify"
}

function compare(plan: Plan, a: Permit, b: Permit): number {
  if (plan.sort === "homes") {
    const homesDelta = plan.dir === "asc" ? a.homes - b.homes : b.homes - a.homes
    if (homesDelta) return homesDelta
    if (a.stated !== b.stated) return a.stated ? -1 : 1
    return (b.ageDays ?? -1) - (a.ageDays ?? -1)
  }
  if (plan.sort === "age") {
    const ageA = a.ageDays ?? -1
    const ageB = b.ageDays ?? -1
    const ageDelta = plan.dir === "asc" ? ageA - ageB : ageB - ageA
    if (ageDelta) return ageDelta
    return b.homes - a.homes
  }
  return (b.ageDays ?? -1) - (a.ageDays ?? -1)
}

function describeWhere(plan: Plan): string {
  const bits: string[] = []
  if (plan.quadrant) bits.push(plan.quadrant)
  if (plan.community) bits.push(titleCase(plan.community))
  if (plan.ward) bits.push(`ward ${plan.ward}`)
  if (plan.sector) bits.push(`${titleCase(plan.sector)} sector`)
  if (plan.srg === "ESTABLISHED") bits.push("established areas")
  if (plan.srg === "DEVELOPING") bits.push("developing areas")
  if (plan.category === "multi") bits.push("multi-family")
  if (plan.category === "suite") bits.push("secondary suites")
  if (plan.category === "single") bits.push("single, semi, and duplex")
  if (plan.status) bits.push(plan.status)
  if (plan.openOnly) bits.push("still in the queue")
  return bits.length ? bits.join(" · ") : "the whole file"
}

function describeRank(plan: Plan): string {
  if (plan.sort === "homes" && plan.dir === "asc") {
    return " Smallest housing counts are first."
  }
  if (plan.sort === "homes") {
    return " Larger housing counts are first, so more homes can be reviewed sooner. Stated unit counts are used when the file has them. Other multi-family files are estimated at 8 homes per building."
  }
  if (plan.sort === "age" && plan.dir === "asc") return " Newest applications are first."
  if (plan.sort === "age") return " Oldest applications are first."
  return ""
}

function toPick(permit: Permit): PickRow {
  return {
    id: permit.id,
    homes: permit.homes,
    stated: permit.stated,
    address: permit.address,
    community: permit.community,
    status: permit.status,
  }
}

export function runAgent(prompt: string, permits: Permit[]): AgentResult {
  const planned = planQuery(prompt, permits)
  if (planned === "reset") {
    return {
      mode: "reset",
      reply: "Showing every location in the file again.",
      ids: [],
      picks: [],
    }
  }
  if (planned === "clarify") {
    return {
      mode: "clarify",
      reply: `Tell me a place, a permit type, or how to rank the files. For example: ${EXAMPLE_HINT}`,
      ids: [],
      picks: [],
    }
  }

  const matched = permits.filter((permit) => {
    if (planned.quadrant && permit.quadrant !== planned.quadrant) return false
    if (planned.community && permit.community.toLowerCase() !== planned.community.toLowerCase()) return false
    if (planned.ward && permit.ward !== planned.ward) return false
    if (planned.sector && permit.sector !== planned.sector) return false
    if (planned.srg && permit.srg !== planned.srg) return false
    if (planned.category && !matchesCategory(permit, planned.category)) return false
    if (planned.status && !permit.status.toLowerCase().includes(planned.status)) return false
    if (planned.openOnly && !isOpenStatus(permit.status)) return false
    return true
  })

  const ranked = [...matched].sort((a, b) => compare(planned, a, b))
  const picked = planned.limit != null ? ranked.slice(0, planned.limit) : ranked
  const where = describeWhere(planned)

  if (picked.length === 0) {
    return {
      mode: "filter",
      reply: `Nothing in the file matched ${where}.`,
      ids: [],
      picks: [],
    }
  }

  const shown = picked.length
  const lead =
    planned.limit != null && matched.length > shown
      ? `${shown.toLocaleString("en-CA")} of ${matched.length.toLocaleString("en-CA")} files in ${where}.`
      : `${shown.toLocaleString("en-CA")} file${shown === 1 ? "" : "s"} in ${where}.`
  const homes = picked.reduce((sum, permit) => sum + permit.homes, 0)
  const homesLine =
    planned.sort === "homes"
      ? ` About ${homes.toLocaleString("en-CA")} homes sit on this list.`
      : ""

  return {
    mode: "filter",
    reply: `${lead}${describeRank(planned)}${homesLine} The map is showing only this list, in blue.`,
    ids: picked.map((permit) => permit.id),
    picks: picked.slice(0, 6).map(toPick),
  }
}

export const SAMPLE_PROMPT = EXAMPLE_HINT
