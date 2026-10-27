import type { PolygonRegion } from './geometry'
import type { ContinuousCityBlock } from './continuous-city-types'
import { boundsOf, overlaps, regionArea, subtractRegions } from './geometry'
import { dissolveContinuousCover, subtractContinuousCover } from './continuous-city-cover'

export interface ContinuousCityLandDomainsInput {
  demandRegions: readonly PolygonRegion[]
  streetBlocks: readonly ContinuousCityBlock[]
}

/** Ownership domains do not certify access. A road can serve land outside a
 * closed street face; only the existing land frontage/physical checks may
 * acquire that ground. Neither demand boundaries nor these new ids are roads.
 * Original street faces remain the authoritative, unchanged map geometry. */
export function buildContinuousCityLandDomains({ demandRegions, streetBlocks }: ContinuousCityLandDomainsInput) {
  const demand = demandRegions.length < 2 ? [...demandRegions] : dissolveContinuousCover(demandRegions)
  const cuts = streetBlocks.map(block => ({ block, bounds: boundsOf(block.polygon), vertices: block.polygon.length + (block.holes ?? []).reduce((sum, ring) => sum + ring.length, 0) }))
  let boundedDifferences = 0
  const remainder = demand.flatMap(region => {
    const bounds = boundsOf(region.polygon), nearby = cuts.filter(cut => overlaps(bounds, cut.bounds))
    if (!nearby.length) return [region]
    const large = nearby.length >= 512 || nearby.reduce((sum, cut) => sum + cut.vertices, 0) >= 12000
    // Large new complements use the validated0.1–0.2mm cover survey lattice.
    // Original block/water geometry is never normalized or reconstructed here.
    if (large) boundedDifferences++
    // Adjacent physical faces share their street-centre boundaries. Unite the
    // exclusion set first, rather than passing every shared edge through the
    // difference as another touching hole. This changes no original face/ref
    // and introduces no processing boundary in the ownership complement.
    // Curved shared faces can send a near-touching 12k-vertex union through a
    // very expensive integer fallback. Smaller working batches retain the
    // same survey precision and balanced merge without touching source faces.
    const obstacles = large ? dissolveContinuousCover(nearby.map(cut => cut.block), { batchVertices: 3000 }) : nearby.map(cut => cut.block)
    return large ? subtractContinuousCover(region, obstacles) : subtractRegions(region, obstacles)
  })
  // Keep disconnected ownership components together; no processing grid or
  // closure street is introduced. Sorting only stabilizes their identifiers.
  const ordered = remainder.map(region => ({ region, bounds: boundsOf(region.polygon), area: regionArea(region) })).sort((a, b) => a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX || a.bounds.maxY - b.bounds.maxY || a.bounds.maxX - b.bounds.maxX || a.area - b.area)
  const usedIds = new Set(streetBlocks.map(block => block.id))
  let serial = 0
  const fringe: ContinuousCityBlock[] = ordered.map(({ region }) => {
    let id: string
    do { id = `continuous-fringe-${serial++}` } while (usedIds.has(id))
    usedIds.add(id)
    return { id, polygon: region.polygon, ...(region.holes?.length ? { holes: region.holes } : {}) }
  })
  const demandArea = demand.reduce((sum, region) => sum + regionArea(region), 0), fringeArea = ordered.reduce((sum, part) => sum + part.area, 0)
  return {
    domains: [...streetBlocks, ...fringe],
    fringe,
    metrics: {
      demandRegions: demandRegions.length,
      demandComponents: demand.length,
      streetBlocks: streetBlocks.length,
      fringeDomains: fringe.length,
      demandArea,
      coveredDemandArea: Math.max(0, demandArea - fringeArea),
      fringeArea,
      boundedDifferences,
    },
  }
}
