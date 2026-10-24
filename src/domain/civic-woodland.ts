import type { Area, Point, TimelineVersion } from './types'
import { boundsOf, overlaps, subtractRegions } from './geometry'
import type { PolygonRegion } from './geometry'

export interface WoodlandClearing { polygon: Point[]; year: number }

/** A campus or wooded park owns land without felling every tree on it. Only
 * surveyed building, plaza and path footprints change woodland, in that year. */
export function civicWoodlandHistory(source: TimelineVersion<Area>[], clearings: WoodlandClearing[], throughYear: number): TimelineVersion<Area>[] {
  const cuts = clearings.filter(cut => cut.year <= throughYear).map(cut => ({ ...cut, bounds: boundsOf(cut.polygon) }))
  const result: TimelineVersion<Area>[] = []
  for (const version of source) {
    if (version.value.kind !== 'forest') { result.push(version); continue }
    const bounds = boundsOf(version.value.polygon), relevant = cuts.filter(cut => (version.to === undefined || cut.year < version.to) && overlaps(bounds, cut.bounds)), dates = [...new Set(relevant.map(cut => Math.max(version.from, cut.year)))].sort((a, b) => a - b)
    let regions: PolygonRegion[] = [{ polygon: version.value.polygon, holes: version.value.holes }], from = version.from
    const record = (to?: number) => {
      if (to !== undefined && to <= from) return
      for (const [i, region] of regions.entries()) result.push({ from, ...(to === undefined ? {} : { to }), value: { ...version.value, ...region, id: i ? `${version.value.id}-fragment-${i}` : version.value.id, ...(i ? { name: undefined } : {}) } })
    }
    for (const date of dates) {
      const batch = relevant.filter(cut => Math.max(version.from, cut.year) === date).map(cut => ({ polygon: cut.polygon }))
      const next = regions.flatMap(region => subtractRegions(region, batch))
      if (next.length === regions.length && next.every((region, i) => region.polygon === regions[i]!.polygon && region.holes === regions[i]!.holes)) continue
      record(date); regions = next; from = date
    }
    record(version.to)
  }
  return result
}
