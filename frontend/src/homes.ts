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
    return {
      homes: units,
      stated: true,
      basis: "Unit count is written on the file.",
    }
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
    return {
      homes: 8,
      stated: false,
      basis: "Multi-family file with no unit count. Counted as 8 homes.",
    }
  }
  if (/semi-detached|semi detached|\bduplex\b/.test(desc)) {
    return {
      homes: 2,
      stated: false,
      basis: "Semi-detached or duplex, counted as 2 homes.",
    }
  }
  return {
    homes: 1,
    stated: false,
    basis: "Counted as 1 home.",
  }
}
