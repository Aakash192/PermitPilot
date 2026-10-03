import { intentSchema, type Intent } from "./contract"

const EMPTY: Intent = {
  type: "explain",
  reply: "",
  openOnly: false,
  limit: null,
  sort: "review",
  quadrant: null,
  ward: null,
  community: null,
}

function findLimit(text: string): number | null {
  const patterns = [
    /\b(?:top|first|next)\s+(\d{1,4})\b/i,
    /\b(\d{1,4})\s+(?:\w+\s+){0,3}(?:files|permits|applications|markers|projects|records)\b/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match) continue
    const count = Number(match[1])
    if (count >= 1 && count <= 500) return count
  }
  return null
}

function findQuadrant(text: string): Intent["quadrant"] {
  if (/\b(sw|southwest|south\s*-?\s*west)\b/.test(text)) return "SW"
  if (/\b(nw|northwest|north\s*-?\s*west)\b/.test(text)) return "NW"
  if (/\b(se|southeast|south\s*-?\s*east)\b/.test(text)) return "SE"
  if (/\b(ne|northeast|north\s*-?\s*east)\b/.test(text)) return "NE"
  return null
}

export function rulesIntent(message: string): Intent {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim()
  if (
    /^(reset|clear|show all|all permits|everything)\b/.test(text) ||
    /\b(show all|show everything|reset the map|clear the filter|clear filters)\b/.test(text)
  ) {
    return { ...EMPTY, type: "reset" }
  }

  const quadrant = findQuadrant(text)
  const ward = text.match(/\bward\s*(\d{1,2})\b/)?.[1] ?? null
  const limit = findLimit(message)
  const aboutReview = /\breview|\bqueue\b|\bthis week\b|\bopen\b|\bpending\b/.test(text)
  const wantsOld = /\boldest\b|\blongest waiting\b|\bfifo\b/.test(text)
  const wantsNew = /\bnewest\b|\bmost recent\b/.test(text)
  const wantsHomes = /\b(homes|houses|housing|units|dwellings)\b/.test(text)
  const actionable = Boolean(quadrant || ward || limit || aboutReview || wantsOld || wantsNew || wantsHomes)

  if (!actionable) {
    return {
      ...EMPTY,
      type: "explain",
      reply:
        "Ask for this week's review list, or narrow it by ward, quadrant, or age. For example: give me the 50 files to review first this week.",
    }
  }

  let sort: Intent["sort"] = "review"
  if (wantsOld) sort = "oldest"
  else if (wantsNew) sort = "newest"
  else if (wantsHomes && !aboutReview) sort = "homes"

  return intentSchema.parse({
    type: "query",
    reply: "",
    openOnly: aboutReview,
    limit,
    sort,
    quadrant,
    ward,
    community: null,
  })
}
