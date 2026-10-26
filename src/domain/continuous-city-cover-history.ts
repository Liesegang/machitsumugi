import type { Area, Road, TimelineVersion } from './types'
import { continuousRoadGround } from './continuous-city-cover'
import type { Bounds, PolygonRegion } from './geometry'
import { boundsOf, intersectRegions, overlaps, rectangle, regionArea, subtractRegions } from './geometry'
import { regionQuery } from './region-query'

export interface ContinuousCoverAcquisition { region: PolygonRegion; from: number }
/** Acquire the same joined pavement that final cover uses. Per-segment
 * rectangles omit bend shoulders and multiply curved roads into tiny cuts.
 * Elevated roads leave the ground beneath them intact. */
export function continuousRoadAcquisitions(roads: readonly Road[]): ContinuousCoverAcquisition[] {
  return roads.flatMap(road => continuousRoadGround(road).map(region => ({ region, from: road.builtYear ?? 1650 })))
}
export interface ContinuousCoverHistoryInput {
  width: number
  height: number
  finalCover: readonly Area[]
  /** Natural/historical cover with only opening-era ground already acquired. */
  baseCover: readonly Area[]
  acquisitions: readonly ContinuousCoverAcquisition[]
}

const tileSize = 320, batchSize = 96
const totalArea = (regions: readonly PolygonRegion[]) => regions.reduce((sum, region) => sum + regionArea(region), 0)

/** Finite, spatially local land conversion. A base piece exists from1650 until
 * its FIRST acquisition, even when a later title overlaps an earlier road.
 * Final IDs all start in2025, preventing createCityTimeline from backdating
 * final cleared areas. This only clips saved geometry; it runs no generation. */
export function buildContinuousCoverHistory(input: ContinuousCoverHistoryInput): TimelineVersion<Area>[] {
  const tiles = new Map<string, (ContinuousCoverAcquisition & { bounds: Bounds })[]>()
  const key = (x: number, y: number) => `${x}:${y}`
  for (const acquisition of input.acquisitions) {
    if (!Number.isFinite(acquisition.from) || acquisition.from > 2025) continue
    const bounds = boundsOf(acquisition.region.polygon), from = Math.max(1650, Math.round(acquisition.from))
    const entry = { ...acquisition, from, bounds }
    for (let x = Math.max(0, Math.floor(bounds.minX / tileSize)); x <= Math.min(Math.ceil(input.width / tileSize) - 1, Math.floor(bounds.maxX / tileSize)); x++) for (let y = Math.max(0, Math.floor(bounds.minY / tileSize)); y <= Math.min(Math.ceil(input.height / tileSize) - 1, Math.floor(bounds.maxY / tileSize)); y++) {
      const id = key(x, y), list = tiles.get(id) ?? []; list.push(entry); tiles.set(id, list)
    }
  }
  for (const list of tiles.values()) list.sort((a, b) => a.from - b.from)
  const history: TimelineVersion<Area>[] = [], finalIds = new Set(input.finalCover.map(area => area.id))
  let serial = 0
  const baseVersion = (base: Area, region: PolygonRegion, to: number, keepName = false) => {
    if (to <= 1650) return
    let id = `land-continuous-cover-history-${serial++}`
    while (finalIds.has(id)) id = `land-continuous-cover-history-${serial++}`
    const { polygon: _polygon, holes: _holes, name, ...metadata } = base
    history.push({ from: 1650, to, value: { ...metadata, ...region, id, ...(keepName && name ? { name } : {}) } })
  }
  for (const base of input.baseCover) {
    // Water is never cleared by road/parcel acquisitions. Preserve its exact
    // rings, islands, level and name; do not create artificial tile shorelines.
    if (base.kind === 'water') { baseVersion(base, base, 2025, true); continue }
    const bounds = boundsOf(base.polygon), inside = regionQuery([base]), edgeBins = new Map<string, Bounds[]>()
    for (const ring of [base.polygon, ...base.holes ?? []]) for (let i = 0; i < ring.length; i++) {
      const edge = boundsOf([ring[i]!, ring[(i + 1) % ring.length]!])
      for (let x = Math.max(0, Math.floor(edge.minX / tileSize)); x <= Math.min(Math.ceil(input.width / tileSize) - 1, Math.floor(edge.maxX / tileSize)); x++) for (let y = Math.max(0, Math.floor(edge.minY / tileSize)); y <= Math.min(Math.ceil(input.height / tileSize) - 1, Math.floor(edge.maxY / tileSize)); y++) {
        const id = key(x, y), list = edgeBins.get(id) ?? []; list.push(edge); edgeBins.set(id, list)
      }
    }
    for (let x = Math.max(0, Math.floor(bounds.minX / tileSize)); x <= Math.min(Math.ceil(input.width / tileSize) - 1, Math.floor(bounds.maxX / tileSize)); x++) for (let y = Math.max(0, Math.floor(bounds.minY / tileSize)); y <= Math.min(Math.ceil(input.height / tileSize) - 1, Math.floor(bounds.maxY / tileSize)); y++) {
      const id = key(x, y), minX = x * tileSize, minY = y * tileSize, maxX = Math.min(input.width, minX + tileSize), maxY = Math.min(input.height, minY + tileSize)
      const tile = { polygon: rectangle(minX, minY, maxX - minX, maxY - minY) }, tileBounds = { minX, minY, maxX, maxY }
      // Interior tiles need no sweep over a large regional forest ring. The
      // edge index proves that one point classification covers the whole tile.
      const boundary = (edgeBins.get(id) ?? []).some(edge => overlaps(edge, tileBounds))
      let remaining = boundary ? intersectRegions(base, tile) : inside({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }) ? [tile] : []
      if (!remaining.length) continue
      const acquisitions = (tiles.get(id) ?? []).filter(entry => overlaps(entry.bounds, tileBounds))
      for (let index = 0; index < acquisitions.length;) {
        const from = acquisitions[index]!.from, cuts: typeof acquisitions = []
        while (index < acquisitions.length && acquisitions[index]!.from === from && cuts.length < batchSize) cuts.push(acquisitions[index++]!)
        const next: PolygonRegion[] = []
        for (const piece of remaining) {
          // Acquisition bounds were measured once for the tile index. Reuse
          // them before the exact predicate, instead of recomputing a growing
          // remainder's bounds/edges for every unrelated title in each batch.
          const bounds = boundsOf(piece.polygon), nearby = cuts.filter(cut => overlaps(bounds, cut.bounds)).map(cut => cut.region)
          if (!nearby.length) { next.push(piece); continue }
          const after = subtractRegions(piece, nearby)
          if (totalArea(after) < regionArea(piece) - .00001) {
            const converted = after.length ? subtractRegions(piece, after) : [piece]
            for (const part of converted) baseVersion(base, part, from)
          }
          next.push(...after)
        }
        remaining = next
        if (!remaining.length) break
      }
      for (const piece of remaining) baseVersion(base, piece, 2025)
    }
  }
  for (const area of input.finalCover) history.push({ from: 2025, value: area })
  return history
}
