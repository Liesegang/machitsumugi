import type { Point } from './types'

export interface LandOpportunity { id: string; point: Point; spacing: number; area: number }

/** Order finite search batches without dropping nearby or low-ranked proposals.
 * Spatial diversity keeps a single difficult site from monopolising a batch;
 * every postponed site remains available when that batch has no viable project. */
export function* diverseOpportunityBatches<T extends { cell: { point: Point } }>(ranked: T[], batchSize = 8, separation = 100): Generator<T[]> {
  const size = Math.max(1, Math.floor(batchSize))
  let remaining = ranked.slice()
  while (remaining.length) {
    const batch: T[] = [], next: T[] = []
    for (const candidate of remaining) {
      if (batch.length < size && batch.every(other => Math.hypot(candidate.cell.point.x - other.cell.point.x, candidate.cell.point.y - other.cell.point.y) > separation)) batch.push(candidate)
      else next.push(candidate)
    }
    // Fill a sparse batch with deferred sites, retaining their original ranking.
    while (batch.length < size && next.length) batch.push(next.shift()!)
    yield batch
    remaining = next
  }
}

/** Variable-resolution Poisson sites for market integration, not street vertices or parcels.
 * Historic centres are evaluated finely; the rural fringe remains coarse. No world axis
 * or universal78m grid is passed into the road geometry. */
export function sampleLandOpportunities(width: number, height: number, center: Point, random: () => number): LandOpportunity[] {
  const sites: LandOpportunity[] = [], active: number[] = [], bins = new Map<string, number[]>(), binSize = 50
  const spacingAt = (p: Point) => 48 + 47 * Math.max(0, Math.min(1, (Math.hypot(p.x - center.x, p.y - center.y) - 250) / 1300))
  const add = (point: Point, spacing: number) => {
    const index = sites.length, key = `${Math.floor(point.x / binSize)},${Math.floor(point.y / binSize)}`
    sites.push({ id: `land-${index}`, point, spacing, area: spacing * spacing / .68 }); active.push(index)
    const bucket = bins.get(key) ?? []; bucket.push(index); bins.set(key, bucket)
  }
  add({ x: Math.max(24, Math.min(width - 24, center.x)), y: Math.max(24, Math.min(height - 24, center.y)) }, 48)
  while (active.length) {
    const chosen = Math.floor(random() * active.length), source = sites[active[chosen]!]!
    let found = false
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = random() * Math.PI * 2, d = source.spacing * (1 + random()), point = { x: source.point.x + Math.cos(angle) * d, y: source.point.y + Math.sin(angle) * d }
      if (point.x < 20 || point.y < 20 || point.x > width - 20 || point.y > height - 20) continue
      const spacing = spacingAt(point), bx = Math.floor(point.x / binSize), by = Math.floor(point.y / binSize), reach = Math.ceil((spacing + 95) / (2 * binSize))
      let allowed = true
      for (let x = bx - reach; x <= bx + reach && allowed; x++) for (let y = by - reach; y <= by + reach && allowed; y++) for (const index of bins.get(`${x},${y}`) ?? []) {
        const other = sites[index]!, minimum = (spacing + other.spacing) / 2
        if ((point.x - other.point.x) ** 2 + (point.y - other.point.y) ** 2 < minimum * minimum) { allowed = false; break }
      }
      if (allowed) { add(point, spacing); found = true; break }
    }
    if (!found) { active[chosen] = active.at(-1)!; active.pop() }
  }
  return sites
}
