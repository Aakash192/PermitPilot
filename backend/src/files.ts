import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parsePermitCsv, type Permit } from "@permit-pilot/core"

const files = new Map<string, Permit[]>()

export function saveCsv(fileId: string, csv: string): { count: number; skipped: number } {
  const parsed = parsePermitCsv(csv)
  if (parsed.permits.length === 0) {
    throw new Error("No locations found. The file needs latitude and longitude columns.")
  }
  files.set(fileId, parsed.permits)
  return { count: parsed.permits.length, skipped: parsed.skipped }
}

export function getFile(fileId: string): Permit[] | undefined {
  return files.get(fileId)
}

export function loadDefaultFile(): { count: number; skipped: number } {
  const here = dirname(fileURLToPath(import.meta.url))
  const csvPath = join(here, "../../frontend/data/calgary_housing_development_permits.csv")
  return saveCsv("default", readFileSync(csvPath, "utf8"))
}
