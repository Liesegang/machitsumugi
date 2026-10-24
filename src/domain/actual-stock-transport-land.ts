import type { Area, CityMap, GrowthEvent, Parcel, TimelineVersion } from './types'
import { boundsOf, intersectRegions, overlaps, regionArea, subtractRegions } from './geometry'
import type { Bounds, PolygonRegion } from './geometry'

export interface ActualTransportLandInput { year: number; strips: PolygonRegion[]; roadIds: string[] }
const convertible = (a: Area) => !a.id.startsWith('castle-') && !a.id.startsWith('moat-') && a.id !== 'historic-core'
  && (a.kind === 'forest' || a.kind === 'field' && a.landUse !== 'wetland')
const hashId = (value: string) => {
  let h = 14695981039346656037n
  for (const c of value) h = BigInt.asUintN(64, (h ^ BigInt(c.codePointAt(0)!)) * 1099511628211n)
  return h.toString(16)
}

/** Spatial broad-phase only. Exact clipping below retains every surviving ring
 * and hole; long projects do not scan every farm/title for every road segment. */
function stripIndex(strips: PolygonRegion[]) {
  const cells = new Map<string, { value: PolygonRegion; bounds: Bounds }[]>()
  for (const value of strips) {
    const bounds = boundsOf(value.polygon), item = { value, bounds }
    for (let x = Math.floor(bounds.minX / 160); x <= Math.floor(bounds.maxX / 160); x++) for (let y = Math.floor(bounds.minY / 160); y <= Math.floor(bounds.maxY / 160); y++) {
      const key = `${x}:${y}`, bucket = cells.get(key) ?? []; bucket.push(item); cells.set(key, bucket)
    }
  }
  return (bounds: Bounds) => {
    const found = new Set<{ value: PolygonRegion; bounds: Bounds }>()
    for (let x = Math.floor(bounds.minX / 160); x <= Math.floor(bounds.maxX / 160); x++) for (let y = Math.floor(bounds.minY / 160); y <= Math.floor(bounds.maxY / 160); y++) {
      for (const item of cells.get(`${x}:${y}`) ?? []) if (overlaps(bounds, item.bounds)) found.add(item)
    }
    return [...found].map(item => item.value)
  }
}

/** Apply ONLY already surveyed, newly acquired ROW deltas. The caller subtracts
 * existing owned paving and rejects water, protected grounds and structures.
 * This helper changes dated land cover and records existing-title easements;
 * it never changes titles, housing, terrain or the transport project itself. */
export function applyActualTransportLand(map: CityMap, input: ActualTransportLandInput): CityMap {
  if (!input.strips.length || !input.roadIds.length || map.timeline && input.year > map.timeline.throughYear) return map
  const query = stripIndex(input.strips), project = hashId([...new Set(input.roadIds)].sort().join('\0'))
  const clip = (area: Area): Area[] => {
    if (!convertible(area)) return [area]
    const cuts = query(boundsOf(area.polygon))
    if (!cuts.length) return [area]
    const pieces = subtractRegions(area, cuts)
    if (regionArea(area) - pieces.reduce((sum, piece) => sum + regionArea(piece), 0) <= 1e-6) return [area]
    return pieces.map((piece, i) => ({ ...area, ...piece, holes: piece.holes,
      id: i ? `transport-cover-${input.year}-${project}-${hashId(area.id)}-${i}` : area.id, ...(i ? { name: undefined } : {}) }))
  }
  const history = map.timeline, currentYear = map.year ?? history?.throughYear ?? input.year
  let historyChanged = false
  const areas: TimelineVersion<Area>[] | undefined = history?.areas.flatMap(version => {
    if (version.to !== undefined && version.to <= input.year) return [version]
    const pieces = clip(version.value)
    if (pieces.length === 1 && pieces[0] === version.value) return [version]
    historyChanged = true
    const from = Math.max(version.from, input.year)
    return [...(version.from < input.year ? [{ ...version, to: input.year }] : []),
      ...pieces.map(value => ({ from, ...(version.to === undefined ? {} : { to: version.to }), value }))]
  })
  const currentAreas = currentYear >= input.year ? map.areas.flatMap(clip) : map.areas
  const currentChanged = currentAreas.length !== map.areas.length || currentAreas.some((a, i) => a !== map.areas[i])
  const acquired = new Map<string, number>()
  const titles: TimelineVersion<Parcel>[] = history?.parcels ?? (map.parcels ?? []).map(value => ({ from: value.createdYear, value }))
  for (const title of titles) {
    if (title.to !== undefined && title.to <= input.year) continue
    const year = Math.max(input.year, title.from), throughYear = history?.throughYear ?? currentYear
    if (year > throughYear || (acquired.get(title.value.id) ?? Infinity) <= year) continue
    if (query(boundsOf(title.value.polygon)).some(strip => intersectRegions(title.value, strip).some(piece => regionArea(piece) > 1e-6))) acquired.set(title.value.id, year)
  }
  const additions: GrowthEvent[] = [...acquired].map(([entityId, year]) => ({ id: `actual-stock-acquisition-${year}-${project}-${hashId(entityId)}`, year, kind: 'acquisition', entityId,
    reason: '道路の新設・拡幅に伴い、既存敷地の形を保って通行部分の道路使用権を設定。' }))
  const append = (events: GrowthEvent[] | undefined, throughYear: number) => {
    const ids = new Set(events?.map(e => e.id)), next = additions.filter(e => e.year <= throughYear && !ids.has(e.id))
    return next.length ? [...events ?? [], ...next] : events
  }
  const events = append(map.events, currentYear), datedEvents = history ? additions.length ? append(history.events ?? map.events, history.throughYear) : history.events : undefined
  if (!historyChanged && !currentChanged && events === map.events && (!history || datedEvents === history.events)) return map
  return { ...map, areas: currentChanged ? currentAreas : map.areas, events,
    ...(history ? { timeline: { ...history, areas: historyChanged ? areas! : history.areas, events: datedEvents } } : {}) }
}
