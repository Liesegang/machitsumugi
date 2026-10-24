import type { Area } from './types'
import { boundsOf, subtractRegions } from './geometry'

export const isMarineWater = (area: Area) => area.kind === 'water' && (area.id === 'sea' || area.id.startsWith('sea-'))

/** One exposed water surface per location. The connected sea is authoritative
 * over a below-sea-level basin; inland standing water covers submerged channels.
 * Retain every exposed fragment and island, without altering the source areas. */
export function partitionWaterAreas(areas: readonly Area[]): Area[] {
  const water = areas.filter(area => area.kind === 'water'), sea = water.filter(isMarineWater)
  const standing = water.filter(area => area.waterLevel !== undefined)
  const bounds = new Map(water.map(area => [area, boundsOf(area.polygon)]))
  return areas.flatMap(area => {
    if (area.kind !== 'water' || isMarineWater(area)) return [area]
    const candidates = area.waterLevel === undefined ? standing : sea, own = bounds.get(area)!
    const masks = candidates.filter(other => {
      if (other === area) return false
      const b = bounds.get(other)!
      return b.minX <= own.maxX && b.maxX >= own.minX && b.minY <= own.maxY && b.maxY >= own.minY
    })
    if (!masks.length) return [area]
    return subtractRegions(area, masks).map((part, i) => ({ ...area, ...part, holes: part.holes, id: i ? `${area.id}-surface-${i}` : area.id }))
  })
}
