import Papa from "papaparse"
import type { Permit } from "./permit"

const CLOSED = new Set(["released", "cancelled", "canceled", "approved"])

export function isOpenStatus(status: string): boolean {
  return !CLOSED.has(status.trim().toLowerCase())
}

export function isQueueStatus(status: string): boolean {
  const value = status.trim().toLowerCase()
  return value !== "released" && value !== "cancelled" && value !== "canceled"
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

export function estimateHomes(category: string, description: string): {
  homes: number
  stated: boolean
  basis: string
} {
  const units = [...description.matchAll(/(\d+)\s*units/gi)].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  )
  if (units > 0) {
    return { homes: units, stated: true, basis: "Unit count is written on the file." }
  }

  const buildings = [...description.matchAll(/(\d+)\s*buildings?/gi)].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  )
  const desc = description.toLowerCase()
  const cat = category.toLowerCase()
  const multi =
    /multi-family|multi family|multi-residential|rowhouse|row house/.test(desc) ||
    /multi-family|rowhouse/.test(cat)

  if (multi && buildings > 0) {
    return {
      homes: buildings * 8,
      stated: false,
      basis: `${buildings} building${buildings === 1 ? "" : "s"} on the file, units not stated. Counted as 8 homes per building.`,
    }
  }
  if (multi) {
    return { homes: 8, stated: false, basis: "Multi-family file with no unit count. Counted as 8 homes." }
  }
  if (/semi-detached|semi detached|\bduplex\b/.test(desc)) {
    return { homes: 2, stated: false, basis: "Semi-detached or duplex, counted as 2 homes." }
  }
  return { homes: 1, stated: false, basis: "Counted as 1 home." }
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
