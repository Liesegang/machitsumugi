import type { CityMap, GrowthEvent, Point, Railway, Road, TimelineVersion } from './types'
import { railwayPavingContact } from './railway-paving-contact'
import { boundsOf, corridorPolygon, distance, distanceToSegment, intersectRegions, overlaps, polygonOverlapsRegion, projectPoint, regionArea } from './geometry'
import type { Bounds, PolygonRegion } from './geometry'

const SERVICE_REASON = '公共施設移転後も沿道の既存敷地に通じる舗装を生活道路として継承'
const active = (v: { from: number; to?: number }, year: number) => v.from <= year && (v.to === undefined || year < v.to)
const civicAccess = (r: Road) => r.role === 'access' && /^(facility-access-|neighbourhood-park-.*-access)/.test(r.id)
const connectable = (r: Road) => !r.controlledAccess && !r.bridge && (r.level ?? 0) === 0
const EPS = 1e-6

/** Static, dated geometry is indexed once, rather than scanning the whole city
 * for every frontage and every historical frame. */
function index<T extends { bounds: Bounds }>(items: T[]) {
  const cells = new Map<string, T[]>()
  for (const item of items) for (let x = Math.floor(item.bounds.minX / 120); x <= Math.floor(item.bounds.maxX / 120); x++) for (let y = Math.floor(item.bounds.minY / 120); y <= Math.floor(item.bounds.maxY / 120); y++) {
    const key = `${x}:${y}`, bucket = cells.get(key) ?? []; bucket.push(item); cells.set(key, bucket)
  }
  return (bounds: Bounds) => {
    const found = new Set<T>()
    for (let x = Math.floor(bounds.minX / 120); x <= Math.floor(bounds.maxX / 120); x++) for (let y = Math.floor(bounds.minY / 120); y <= Math.floor(bounds.maxY / 120); y++) for (const item of cells.get(`${x}:${y}`) ?? []) if (overlaps(bounds, item.bounds)) found.add(item)
    return found
  }
}

function measured(points: Point[]) {
  const along = [0]
  for (let i = 1; i < points.length; i++) along.push(along[i - 1]! + distance(points[i - 1]!, points[i]!))
  const at = (s: number): Point => {
    for (let i = 1; i < points.length; i++) if (s <= along[i]! + EPS) {
      const a = points[i - 1]!, b = points[i]!, t = Math.max(0, Math.min(1, (s - along[i - 1]!) / (along[i]! - along[i - 1]! || 1)))
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    return points.at(-1)!
  }
  return {
    along, length: along.at(-1)!,
    project(p: Point) {
      let best = { along: 0, distance: Infinity }
      for (let i = 1; i < points.length; i++) {
        const q = projectPoint(p, points[i - 1]!, points[i]!), d = distance(p, q)
        if (d < best.distance) best = { along: along[i - 1]! + distance(points[i - 1]!, q), distance: d }
      }
      return best
    },
    slice(from: number, to: number) { return [at(from), ...points.filter((_, i) => along[i]! > from + EPS && along[i]! < to - EPS), at(to)] },
  }
}

/** Includes endpoint and collinear contacts. Point order does not identify the
 * source end: a later through street can meet an old driveway in its middle. */
function contacts(a: Point, b: Point, c: Point, d: Point): Point[] {
  const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y, det = dx * ey - dy * ex
  if (Math.abs(det) < 1e-10) return [a, b, c, d].filter(p => distanceToSegment(p, a, b) < EPS && distanceToSegment(p, c, d) < EPS)
  const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / det, u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / det
  return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? [{ x: a.x + dx * Math.max(0, Math.min(1, t)), y: a.y + dy * Math.max(0, Math.min(1, t)) }] : []
}

function insertJunctions(road: Road, junctions: Point[]): Road {
  if (!junctions.length) return road
  const points: Point[] = []
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!
    points.push(a, ...junctions.filter(p => distance(p, a) > EPS && distance(p, b) > EPS && distanceToSegment(p, a, b) < EPS)
      .sort((p, q) => distance(a, p) - distance(a, q)).filter((p, j, all) => !j || distance(p, all[j - 1]!) > EPS))
  }
  points.push(road.points.at(-1)!)
  return points.length === road.points.length ? road : { ...road, points }
}

export interface CivicAccessRetention {
  roadId: string; from: number; to?: number; length: number; parcelIds: string[]; sourceRoadId: string
}
export interface UnresolvedCivicAccess { roadId: string; year: number; parcelIds: string[]; reason: string }

/** Adopt only still-used, physically available pieces of an already surveyed
 * driveway. Campus retirement and street retirement are separate decisions.
 *
 * This pure finalization uses the same dated stock for fresh generation and for
 * diagnostics on a saved completed simulation. It never edits land ownership,
 * buildings, terrain, or the original opening/retirement versions. */
export function retainCivicAccess(map: CityMap, validate?: (road: Road, year: number) => string | undefined): {
  map: CityMap; retained: CivicAccessRetention[]; unresolved: UnresolvedCivicAccess[]
} {
  const history = map.timeline
  if (!history) return { map, retained: [], unresolved: [] }
  const alreadyRetained = new Set(history.roads.filter(v => v.value.reason === SERVICE_REASON).map(v => v.value.id))
  const candidates = history.roads.filter(v => v.to !== undefined && civicAccess(v.value) && connectable(v.value) && !alreadyRetained.has(v.value.id)
    && !history.roads.some(next => next.value.id === v.value.id && next.from >= v.to!)).sort((a, b) => a.to! - b.to! || a.value.id.localeCompare(b.value.id))
  if (!candidates.length) return { map, retained: [], unresolved: [] }

  const parcelVersions = new Map<string, typeof history.parcels>()
  for (const v of history.parcels) { const group = parcelVersions.get(v.value.id) ?? []; group.push(v); parcelVersions.set(v.value.id, group) }
  type Service = { from: number; to?: number; parcelId: string; entrance: Point }
  const service = new Map<string, Service[]>()
  for (const building of history.buildings) if (building.value.parcelId) for (const parcel of parcelVersions.get(building.value.parcelId) ?? []) {
    const from = Math.max(building.from, parcel.from), to = Math.min(building.to ?? Infinity, parcel.to ?? Infinity)
    if (from >= to) continue
    const group = service.get(parcel.value.roadId) ?? []
    group.push({ from, ...(Number.isFinite(to) ? { to } : {}), parcelId: parcel.value.id, entrance: parcel.value.entrance }); service.set(parcel.value.roadId, group)
  }
  type Segment = TimelineVersion<Road> & { a: Point; b: Point; bounds: Bounds }
  const streetSegments = history.roads.filter(v => connectable(v.value)).flatMap(v => v.value.points.slice(1).map((b, i): Segment => ({ ...v, a: v.value.points[i]!, b, bounds: boundsOf([v.value.points[i]!, b]) })))
  const nearbyStreets = index(streetSegments)
  type Mask = TimelineVersion<PolygonRegion & { id: string }> & { bounds: Bounds; titleAcquired?: number; railway?: Railway; segment?: number }
  const masks: Mask[] = [
    ...history.areas.filter(v => v.value.kind === 'water' || v.value.kind === 'park' || v.value.id.startsWith('castle-')),
    ...history.buildings,
  ].map(v => ({ ...v, bounds: boundsOf(v.value.polygon) }))
  // Older title polygons can already contain a surveyed public right-of-way.
  // Only a new title acquired after closure can take the retired paving back;
  // all standing structures, including later buildings on old titles, block it.
  masks.push(...history.parcels.map(v => ({ ...v, bounds: boundsOf(v.value.polygon), titleAcquired: v.value.createdYear })))
  // A retained local driveway cannot acquire a new railway crossing or a
  // viaduct. Existing station/railway land remains a physical constraint.
  for (const version of history.railways.filter(v => v.value.mode !== 'subway')) for (let i = 1; i < version.value.points.length; i++) {
    const a = version.value.points[i - 1]!, b = version.value.points[i]!
    if (distance(a, b) < .01) continue
    const polygon = corridorPolygon(a, b, 7.5)
    masks.push({ from: version.from, to: version.to, value: { id: version.value.id, polygon }, bounds: boundsOf(polygon), railway: version.value, segment: i - 1 })
  }
  for (const version of history.stations) if (version.value.buildingPolygon) masks.push({ from: version.from, to: version.to, value: { id: version.value.id, polygon: version.value.buildingPolygon }, bounds: boundsOf(version.value.buildingPolygon) })
  const nearbyMasks = index(masks)
  const years = [...new Set([history.throughYear, ...(history.snapshots ?? []).map(s => s.year), ...[...history.roads, ...history.parcels, ...history.buildings, ...history.areas, ...history.railways, ...history.stations].flatMap(v => [v.from, ...(v.to === undefined ? [] : [v.to])])])].filter(y => y <= history.throughYear).sort((a, b) => a - b)
  const additions: TimelineVersion<Road>[] = [], retained: CivicAccessRetention[] = [], unresolved: UnresolvedCivicAccess[] = []
  const junctions = new Map<string, Point[]>()
  const addJunction = (id: string, point: Point) => { const points = junctions.get(id) ?? []; points.push(point); junctions.set(id, points) }
  const failure = (roadId: string, year: number, parcelIds: string[], reason: string) => {
    if (!unresolved.some(item => item.roadId === roadId && item.reason === reason)) unresolved.push({ roadId, year, parcelIds, reason })
  }

  type State = { original: TimelineVersion<Road>; measure: ReturnType<typeof measured>; available: { from: number; to: number }; previous?: TimelineVersion<Road>; stopped: boolean }
  const candidateIds = new Set(candidates.map(v => v.value.id))
  const context = history.roads.filter(v => civicAccess(v.value) && connectable(v.value) && !candidateIds.has(v.value.id))
  const states: State[] = [...candidates, ...context].map(original => { const measure = measured(original.value.points); return { original, measure, available: { from: 0, to: measure.length }, stopped: false } })
  type Contact = { state: State; point: Point; along: number; sourceId: string; sourceAlong?: number; parent?: State }
  // Same-year decisions use one rooted contact graph. A parent driveway can be
  // adopted decades after its child; processing whole road lifetimes separately
  // would otherwise close the child before the parent's adoption is known.
  for (const year of years) {
    if (!candidates.some(v => v.to! <= year)) continue
    const due = states.filter(s => s.original.from <= year && !s.stopped && (candidateIds.has(s.original.value.id) || active(s.original, year)))
    if (!due.length) continue
    const ids = new Set(due.map(s => s.original.value.id)), properties = new Map<State, Service[]>(), frontages = new Map<State, number[]>(), blocked = new Map<State, string>()
    for (const state of due) {
      const items = (service.get(state.original.value.id) ?? []).filter(v => active(v, year)), projections = items.map(v => state.measure.project(v.entrance))
      properties.set(state, items); frontages.set(state, active(state.original, year) ? [0, state.measure.length, ...projections.map(p => p.along)] : projections.map(p => p.along))
      if (projections.some(p => p.along < state.available.from - EPS || p.along > state.available.to + EPS || p.distance > state.original.value.width / 2 + 6)) blocked.set(state, '既に廃止した舗装の復活を必要とする敷地があります。')
    }
    const rootContacts: Contact[] = [], between: Contact[] = []
    for (const state of due) {
      const road = state.original.value
      for (let i = 1; i < road.points.length; i++) for (const source of nearbyStreets(boundsOf([road.points[i - 1]!, road.points[i]!]))) if (!ids.has(source.value.id) && source.value.id !== road.id && active(source, year)) {
        for (const point of contacts(road.points[i - 1]!, road.points[i]!, source.a, source.b)) {
          const along = state.measure.along[i - 1]! + distance(road.points[i - 1]!, point)
          if (along >= state.available.from - EPS && along <= state.available.to + EPS) rootContacts.push({ state, point, along, sourceId: source.value.id })
        }
      }
      for (const parent of due) if (parent !== state && overlaps(boundsOf(road.points), boundsOf(parent.original.value.points))) for (let i = 1; i < road.points.length; i++) for (let j = 1; j < parent.original.value.points.length; j++) {
        for (const point of contacts(road.points[i - 1]!, road.points[i]!, parent.original.value.points[j - 1]!, parent.original.value.points[j]!)) {
          const along = state.measure.along[i - 1]! + distance(road.points[i - 1]!, point), sourceAlong = parent.measure.along[j - 1]! + distance(parent.original.value.points[j - 1]!, point)
          if (along >= state.available.from - EPS && along <= state.available.to + EPS && sourceAlong >= parent.available.from - EPS && sourceAlong <= parent.available.to + EPS) between.push({ state, point, along, sourceId: parent.original.value.id, sourceAlong, parent })
        }
      }
    }
    let tree = new Map<State, Contact>(), ranges = new Map<State, { from: number; to: number }>(), order: State[] = []
    for (let attempt = 0; attempt <= due.length; attempt++) {
      const costs = new Map<State, number>(); tree = new Map(); order = []
      const span = (state: State, along: number) => { const points = [along, ...frontages.get(state)!]; return Math.max(...points) - Math.min(...points) }
      for (const contact of rootContacts) if (!blocked.has(contact.state)) {
        const cost = span(contact.state, contact.along)
        if (cost < (costs.get(contact.state) ?? Infinity)) { costs.set(contact.state, cost); tree.set(contact.state, contact) }
      }
      const visited = new Set<State>()
      while (true) {
        const state = due.filter(s => !visited.has(s) && costs.has(s)).sort((a, b) => costs.get(a)! - costs.get(b)! || a.original.value.id.localeCompare(b.original.value.id))[0]
        if (!state) break
        visited.add(state); order.push(state)
        for (const contact of between.filter(c => c.parent === state && !visited.has(c.state) && !blocked.has(c.state))) {
          const cost = costs.get(state)! + Math.abs(contact.sourceAlong! - tree.get(state)!.along) + span(contact.state, contact.along)
          if (cost < (costs.get(contact.state) ?? Infinity)) { costs.set(contact.state, cost); tree.set(contact.state, contact) }
        }
      }
      const required = new Map<State, number[]>()
      for (const state of due) required.set(state, [...frontages.get(state)!])
      ranges = new Map()
      for (const state of [...order].reverse()) {
        const needed = required.get(state)!, contact = tree.get(state)!
        if (!needed.length) continue
        needed.push(contact.along)
        let from = Math.min(...needed), to = Math.max(...needed)
        if (to - from < .01) { from = Math.max(state.available.from, from - .01); to = Math.min(state.available.to, to + .01) }
        ranges.set(state, { from, to })
        if (contact.parent) required.get(contact.parent)!.push(contact.sourceAlong!)
      }
      let rejected = false
      for (const [state, range] of ranges) {
        if (active(state.original, year)) continue // Existing open civic paving is not being re-adopted.
        const value: Road = { ...state.original.value, points: state.measure.slice(range.from, range.to), modifiedYear: year, reason: SERVICE_REASON }
        let reason: string | undefined
        for (let i = 1; i < value.points.length && !reason; i++) {
          const polygon = corridorPolygon(value.points[i - 1]!, value.points[i]!, value.width / 2), bounds = boundsOf(polygon)
          for (const mask of nearbyMasks(bounds)) if (active(mask, year) && (mask.titleAcquired === undefined || mask.titleAcquired >= state.original.to!) && polygonOverlapsRegion(polygon, mask.value)
            && (!mask.railway || railwayPavingContact(mask.railway, mask.segment!, polygon, history.terrainSurfaces.find(v => active(v, year))?.value) !== 'separated')
            && intersectRegions({ polygon }, mask.value).reduce((n, p) => n + regionArea(p), 0) > .01) { reason = `継承する舗装が取得済みの用地と重なります: ${mask.value.id}`; break }
        }
        reason ??= validate?.(value, year)
        if (reason) { blocked.set(state, reason); rejected = true }
      }
      if (!rejected) break
    }
    for (const state of due) {
      if (active(state.original, year)) continue
      const road = state.original.value, range = ranges.get(state), contact = tree.get(state), parcelIds = [...new Set(properties.get(state)!.map(p => p.parcelId))]
      if (!range || !contact || blocked.has(state)) {
        if (parcelIds.length) failure(road.id, year, parcelIds, blocked.get(state) ?? '接続する現役の生活道路がありません。')
        if (state.previous) state.previous.to = year
        state.stopped = true; continue
      }
      addJunction(road.id, contact.point); addJunction(contact.sourceId, contact.point)
      // Add all contacts as physical shared vertices, even when a later street
      // meets the middle of a still-used span without changing its endpoints.
      for (const other of [...rootContacts, ...between].filter(c => c.state === state && c.along >= range.from - EPS && c.along <= range.to + EPS && (!c.parent || ranges.has(c.parent)))) {
        addJunction(road.id, other.point); addJunction(other.sourceId, other.point)
      }
      if (state.previous && Math.abs(state.available.from - range.from) < EPS && Math.abs(state.available.to - range.to) < EPS) continue
      if (state.previous) state.previous.to = year
      state.previous = { from: year, value: { ...road, points: state.measure.slice(range.from, range.to), modifiedYear: year, reason: SERVICE_REASON } }; additions.push(state.previous)
      retained.push({ roadId: road.id, from: year, length: range.to - range.from, parcelIds, sourceRoadId: contact.sourceId })
      state.available = range
    }
  }
  for (const record of retained) { const version = additions.find(v => v.value.id === record.roadId && v.from === record.from)!; if (version.to !== undefined) record.to = version.to }
  if (!additions.length) return { map, retained, unresolved }
  const originalRoads = history.roads.map(v => ({ ...v, value: insertJunctions(v.value, junctions.get(v.value.id) ?? []) }))
  const roadHistory = [...originalRoads, ...additions.map(v => ({ ...v, value: insertJunctions(v.value, junctions.get(v.value.id) ?? []) }))]
  const newEvents: GrowthEvent[] = additions.map(v => ({ id: `event-road-service-${v.value.id}-${v.from}`, year: v.from, kind: 'road', entityId: v.value.id, reason: SERVICE_REASON }))
  const events = [...map.events ?? [], ...newEvents], datedEvents = [...history.events ?? map.events ?? [], ...newEvents]
  const updateSnapshots = (snapshots: CityMap['snapshots']) => snapshots?.map(snapshot => ({ ...snapshot, roads: roadHistory.filter(v => active(v, snapshot.year)).length }))
  return { map: { ...map, roads: roadHistory.filter(v => active(v, map.year ?? history.throughYear)).map(v => v.value), events, snapshots: updateSnapshots(map.snapshots),
    timeline: { ...history, roads: roadHistory, events: datedEvents, snapshots: updateSnapshots(history.snapshots) } }, retained, unresolved }
}
