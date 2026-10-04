import Papa from "papaparse"
import { estimateHomes } from "./homes"
import type { Permit } from "./types"

// Only these statuses still need a planner decision. Pending Release and In Advertising
// already have a decision date, and Hold is paused, so they are not in the queue.
const NEEDS_DECISION = new Set(["new", "in circulation", "under review", "pending decision"])

export function isOpenStatus(status: string): boolean {
  return NEEDS_DECISION.has(status.trim().toLowerCase())
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[\s_]+/g, "")
}

function findColumn(headers: string[], names: string[]): string | undefined {
  const byNorm = new Map(headers.map((header) => [norm(header), header]))
  for (const name of names) {
    const hit = byNorm.get(norm(name))
    if (hit) return hit
  }
  return undefined
}

function cell(row: Record<string, string>, key: string | undefined): string {
  if (!key) return ""
  return String(row[key] ?? "").trim()
}

function parseNumber(value: string): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function ageDays(applied: string, today: Date): number | null {
  if (!applied) return null
  const time = Date.parse(applied)
  if (Number.isNaN(time)) return null
  const days = Math.floor((today.getTime() - time) / 86_400_000)
  return Math.max(0, days)
}

export function parsePermitCsv(text: string, today = new Date()): {
  permits: Permit[]
  skipped: number
} {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  })
  const headers = parsed.meta.fields ?? []
  const latKey = findColumn(headers, ["latitude", "lat", "y"])
  const lngKey = findColumn(headers, ["longitude", "lng", "lon", "long", "x"])
  if (!latKey || !lngKey) return { permits: [], skipped: parsed.data.length }

  const idKey = findColumn(headers, ["permitnum", "permit", "id", "file"])
  const addressKey = findColumn(headers, ["address", "siteaddress", "name", "title"])
  const categoryKey = findColumn(headers, ["category", "type", "permittype"])
  const descriptionKey = findColumn(headers, ["description", "desc", "scope"])
  const statusKey = findColumn(headers, ["statuscurrent", "status"])
  const appliedKey = findColumn(headers, ["applieddate", "applied", "applicationdate", "date"])
  const communityKey = findColumn(headers, ["communityname", "community", "neighbourhood", "neighborhood"])
  const wardKey = findColumn(headers, ["ward"])
  const quadrantKey = findColumn(headers, ["quadrant", "quad"])
  const sectorKey = findColumn(headers, ["sector"])
  const srgKey = findColumn(headers, ["srg"])

  const permits: Permit[] = []
  const seenIds = new Map<string, number>()
  let skipped = 0

  parsed.data.forEach((row, index) => {
    let lat = parseNumber(cell(row, latKey))
    let lng = parseNumber(cell(row, lngKey))
    if (lat == null || lng == null) {
      skipped += 1
      return
    }
    if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
      const swap = lat
      lat = lng
      lng = swap
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      skipped += 1
      return
    }

    const category = cell(row, categoryKey)
    const description = cell(row, descriptionKey)
    const homes = estimateHomes(category, description)
    const applied = cell(row, appliedKey)
    const baseId = cell(row, idKey) || `row-${index + 1}`
    const seen = seenIds.get(baseId) ?? 0
    seenIds.set(baseId, seen + 1)
    const id = seen === 0 ? baseId : `${baseId} (${seen + 1})`
    const ward = cell(row, wardKey).replace(/\.0$/, "")

    permits.push({
      id,
      address: cell(row, addressKey),
      category,
      description,
      status: cell(row, statusKey),
      applied,
      community: cell(row, communityKey),
      ward,
      quadrant: cell(row, quadrantKey).toUpperCase(),
      sector: cell(row, sectorKey).toUpperCase(),
      srg: cell(row, srgKey).toUpperCase(),
      lat,
      lng,
      homes: homes.homes,
      stated: homes.stated,
      basis: homes.basis,
      ageDays: ageDays(applied, today),
    })
  })

  return { permits, skipped }
}
