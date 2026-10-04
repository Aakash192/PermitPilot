import type { ChatResponse, Intent } from "./contract"
import { isQueueStatus } from "./parse"
import type { Permit } from "./permit"

const REVIEW_LIMIT = 50

function isMultiFamily(permit: Permit): boolean {
  const blob = `${permit.category} ${permit.description}`.toLowerCase()
  return /multi-family|multi family|multi-residential|rowhouse|row house/.test(blob)
}

function dayTarget(srg: string): number {
  return srg === "DEVELOPING" ? 100 : 186
}

function typeWeight(permit: Permit): number {
  if (isMultiFamily(permit)) return 3
  const blob = `${permit.category} ${permit.description}`.toLowerCase()
  if (/new single|contextual|secondary suite|additions/.test(blob)) return 2
  return 1
}

export function reviewScore(permit: Permit): number {
  const age = permit.ageDays ?? 0
  const over = Math.max(0, age - dayTarget(permit.srg))
  return over * typeWeight(permit) + 0.1 * age
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b[\w']/g, (letter) => letter.toUpperCase())
}

function neighbourhoodPhrase(permits: Permit[]): string {
  const counts = new Map<string, number>()
  for (const permit of permits) {
    const key = permit.srg || "UNKNOWN"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([srg, count]) => {
    const label = srg === "UNKNOWN" ? "unknown areas" : `${titleCase(srg)} areas`
    return `${count} in ${label}`
  })
  if (parts.length === 0) return ""
  if (parts.length === 1) return parts[0] ?? ""
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
}

function reviewReply(chosen: Permit[], pool: Permit[]): string {
  const oldest = [...pool].sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1)).slice(0, chosen.length)
  const oldestIds = new Set(oldest.map((permit) => permit.id))
  const different = chosen.filter((permit) => !oldestIds.has(permit.id)).length
  const keep = Math.max(1, Math.floor(chosen.length * 0.8))
  const dropped = chosen.slice(keep)
  const slots = chosen.length
  const shorter = keep
  const dropLine =
    dropped.length === 0
      ? ""
      : ` If the team only has ${shorter} slots, ${dropped.length} files drop: ${neighbourhoodPhrase(dropped)}.`

  return `Work these ${slots} open files first. They are ranked by days past the target, 100 days in developing areas and 186 in established areas, with extra weight for multi-family. Oldest-first would have picked ${different} different files.${dropLine} The map is showing this list.`
}

function filterReply(intent: Intent, chosen: Permit[], pool: Permit[]): string {
  const place = [
    intent.quadrant,
    intent.ward ? `ward ${intent.ward}` : "",
    intent.community ? titleCase(intent.community) : "",
    intent.openOnly ? "still in the queue" : "",
  ].filter(Boolean)
  const where = place.length ? place.join(" · ") : "the file"
  const rank =
    intent.sort === "oldest"
      ? " Oldest applications are first."
      : intent.sort === "newest"
        ? " Newest applications are first."
        : intent.sort === "homes"
          ? " Larger housing counts are first."
          : ""
  const capped = intent.limit != null && pool.length > chosen.length
  const lead = capped
    ? `${chosen.length} of ${pool.length} files in ${where}.`
    : `${chosen.length} file${chosen.length === 1 ? "" : "s"} in ${where}.`
  return `${lead}${rank} The map is showing only this list.`
}

export function executeIntent(intent: Intent, permits: Permit[]): ChatResponse {
  if (intent.type === "explain") {
    return {
      reply: intent.reply || "Tell me which applications you want on the map.",
      map: { kind: "none" },
    }
  }
  if (intent.type === "reset") {
    return {
      reply: "Showing every location in the file again.",
      map: { kind: "showAll" },
    }
  }

  const openOnly = intent.sort === "review" ? true : intent.openOnly
  const pool = permits.filter((permit) => {
    if (openOnly && !isQueueStatus(permit.status)) return false
    if (intent.quadrant && permit.quadrant !== intent.quadrant) return false
    if (intent.ward && permit.ward !== intent.ward) return false
    if (intent.community && permit.community.toLowerCase() !== intent.community.toLowerCase()) return false
    return true
  })

  const limit = intent.limit ?? (intent.sort === "review" ? REVIEW_LIMIT : null)
  const ranked = [...pool].sort((a, b) => {
    if (intent.sort === "review") return reviewScore(b) - reviewScore(a)
    if (intent.sort === "homes") return b.homes - a.homes || (b.ageDays ?? -1) - (a.ageDays ?? -1)
    if (intent.sort === "newest") return (a.ageDays ?? Number.MAX_SAFE_INTEGER) - (b.ageDays ?? Number.MAX_SAFE_INTEGER)
    return (b.ageDays ?? -1) - (a.ageDays ?? -1)
  })
  const chosen = limit == null ? ranked : ranked.slice(0, limit)

  if (chosen.length === 0) {
    return {
      reply: "Nothing in the loaded file matched that request. The map is unchanged.",
      map: { kind: "none" },
    }
  }

  return {
    reply: intent.sort === "review" ? reviewReply(chosen, pool) : filterReply(intent, chosen, pool),
    map: { kind: "show", permitIds: chosen.map((permit) => permit.id) },
  }
}
