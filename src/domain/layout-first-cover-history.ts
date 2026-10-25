import type { Area, Road, TimelineVersion } from './types'
import type { Bounds, PolygonRegion } from './geometry'
import type { LayoutFirstCoverInput } from './layout-first-cover'
import { layoutRoadClearance, mergeLayoutCoverRegions, removeLayoutCoverRegions } from './layout-first-cover'
import { boundsOf, overlaps, pointInRegion, regionArea } from './geometry'

export interface LayoutFirstCoverHistoryInput {
  input: LayoutFirstCoverInput
  finalCover: Area[]
  reserveDates: { region: PolygonRegion; from: number }[]
  roadHistory?: TimelineVersion<Road>[]
  areaDates?: { id: string; from: number }[]
}
interface DatedRegion extends PolygonRegion { from: number; bounds: Bounds }
const clampedYear = (year: number) => Math.max(1650, Math.min(2025, Math.round(year)))
const sourcePrefix = (area: Area) => `land-layout-${area.id}-`
function hash(value: string) {
  let h = 2166136261
  for (const character of value) h = Math.imul(h ^ character.charCodeAt(0), 16777619)
  return (h >>> 0).toString(36)
}
function clearanceIndex(regions: DatedRegion[], size = 200) {
  const bins = new Map<string, DatedRegion[]>()
  for (const region of regions) for (let x = Math.floor(region.bounds.minX / size); x <= Math.floor(region.bounds.maxX / size); x++) for (let y = Math.floor(region.bounds.minY / size); y <= Math.floor(region.bounds.maxY / size); y++) {
    const key = `${x}:${y}`, group = bins.get(key) ?? []; group.push(region); bins.set(key, group)
  }
  return (bounds: Bounds) => {
    const found = new Set<DatedRegion>()
    for (let x = Math.floor(bounds.minX / size); x <= Math.floor(bounds.maxX / size); x++) for (let y = Math.floor(bounds.minY / size); y <= Math.floor(bounds.maxY / size); y++) for (const region of bins.get(`${x}:${y}`) ?? []) if (overlaps(bounds, region.bounds)) found.add(region)
    return [...found]
  }
}

/** Incremental natural-cover acquisition, not repeated whole-map generation.
 * Only newly acquired clearances touch each remaining forest component. The
 * complete current grass/farm/water composition is reused without rerasterizing
 * or unioning it at every historical date. Geometry changes only at real dates.
 */
export function layoutFirstCoverHistory({ input, finalCover, reserveDates, roadHistory, areaDates }: LayoutFirstCoverHistoryInput): TimelineVersion<Area>[] {
  const overrides = new Map(areaDates?.map(date => [date.id, clampedYear(date.from)]))
  const originalNatural = input.terrain.areas.filter(area => area.kind !== 'water')
  const isNatural = (area: Area) => originalNatural.some(original => area.id.startsWith(sourcePrefix(original)))
  const opening = (area: Area) => {
    if (overrides.has(area.id)) return overrides.get(area.id)!
    if (area.id.startsWith('layout-field-')) {
      const road = input.roads.filter(road => area.id.startsWith(`layout-field-${road.id}-`)).sort((a, b) => b.id.length - a.id.length)[0]
      return clampedYear(road?.builtYear ?? 1650)
    }
    return 1650
  }
  const passive = finalCover.filter(area => !isNatural(area)).map(value => ({ from: opening(value), value }))
  // A terrain without natural forest/woodland has no historic canopy to clip.
  // In particular, forest=0 does not pay for road unions or dated title loops.
  if (!originalNatural.length) return passive
  const naturalBounds = originalNatural.map(area => boundsOf(area.polygon))
  const groups = new Map<number, DatedRegion[]>()
  const add = (region: PolygonRegion, from: number) => {
    const bounds = boundsOf(region.polygon)
    if (!naturalBounds.some(natural => overlaps(natural, bounds))) return
    const year = clampedYear(from)
    if (year >= 2025) return // Current geometry is already present in finalCover.
    const list = groups.get(year) ?? []; list.push({ ...region, from: year, bounds }); groups.set(year, list)
  }
  for (const parcel of input.parcels) add({ polygon: parcel.polygon }, parcel.createdYear)
  for (const date of reserveDates) add(date.region, date.from)
  const roads = roadHistory ?? input.roads.map(value => ({ from: value.builtYear ?? 1650, value }))
  for (const version of roads) if ((version.value.level ?? 0) === 0) {
    const roadBounds = boundsOf(version.value.points)
    const margin = version.value.width / 2 + 1
    const expanded = { minX: roadBounds.minX - margin, minY: roadBounds.minY - margin, maxX: roadBounds.maxX + margin, maxY: roadBounds.maxY + margin }
    if (naturalBounds.some(bounds => overlaps(bounds, expanded))) for (const region of layoutRoadClearance(version.value)) add(region, version.from)
  }
  const titleIds = new Set(input.parcels.map(parcel => parcel.id))
  for (const building of input.buildings ?? []) if ((!building.parcelId || !titleIds.has(building.parcelId)) && !reserveDates.some(date => building.polygon.every(point => pointInRegion(point, date.region)))) add({ polygon: building.polygon }, building.builtYear ?? 1650)
  // Merge only this phase's local deltas. A 1995 subdivision never forces the
  // 1650 roads, every earlier title and global meadow to be unioned again.
  const phases = [...groups].sort(([a], [b]) => a - b).map(([year, clearances]) => ({ year, query: clearanceIndex(mergeLayoutCoverRegions(clearances).map(region => ({ ...region, from: year, bounds: boundsOf(region.polygon) }))) }))
  const naturalHistory: TimelineVersion<Area>[] = []
  for (const original of originalNatural) {
    let sequence = 0
    let active: TimelineVersion<Area>[] = [{ from: 1650, value: original }]
    const retired: TimelineVersion<Area>[] = []
    for (const phase of phases) {
      const next: TimelineVersion<Area>[] = []
      for (const version of active) {
        const cuts = phase.query(boundsOf(version.value.polygon))
        if (!cuts.length) { next.push(version); continue }
        const pieces = removeLayoutCoverRegions(version.value, cuts)
        const before = regionArea(version.value), after = pieces.reduce((sum, piece) => sum + regionArea(piece), 0)
        if (before - after <= 1e-5) { next.push(version); continue }
        if (phase.year > version.from) retired.push({ ...version, to: phase.year })
        const kept = pieces.filter(part => regionArea(part) >= (original.kind === 'forest' ? 1200 : 80)).sort((a, b) => regionArea(b) - regionArea(a))
        for (const [i, part] of kept.entries()) {
          const woodland = original.kind === 'forest' && regionArea(part) < 18000
          next.push({ from: phase.year, value: { ...version.value, ...part, holes: part.holes, id: `cover-history-${hash(original.id)}-${phase.year}-${sequence++}`,
            ...(woodland ? { kind: 'park', landUse: 'woodland', name: undefined } : i ? { name: undefined } : {}) } })
        }
      }
      active = next
    }
    naturalHistory.push(...retired, ...active.map(version => ({ ...version, to: 2025 })), ...finalCover.filter(area => area.id.startsWith(sourcePrefix(original))).map(value => ({ from: 2025, value })))
  }
  // Keep the painting order: grass, natural canopy, farms and finally water.
  const water = passive.filter(version => version.value.kind === 'water'), farms = passive.filter(version => version.value.id.startsWith('layout-field-'))
  return [...passive.filter(version => version.value.kind !== 'water' && !version.value.id.startsWith('layout-field-')), ...naturalHistory, ...farms, ...water]
}
