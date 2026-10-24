import type { Building, CityMap, GrowthEvent, Point, Road, SimulationSnapshot, TimelineVersion } from './types'
import { retainCivicAccess } from './civic-access-retention'
import type { UnresolvedCivicAccess } from './civic-access-retention'
import { pavingFullyTaken } from './railway-paving-contact'
import { boundsOf, corridorPolygon, distance, distanceToSegment, intersectRegions, overlaps, pointInRegion, polygonOverlapsRegion, projectPoint, regionArea } from './geometry'

const active = (v: { from: number; to?: number }, year: number) => v.from <= year && (v.to === undefined || year < v.to)
const street = (r: Road) => !r.controlledAccess && !r.bridge && (r.level ?? 0) === 0
const crossedArea = (a: Point[], b: Point[]) => overlaps(boundsOf(a), boundsOf(b)) && polygonOverlapsRegion(a, { polygon: b }) ? intersectRegions({ polygon: a }, { polygon: b }).reduce((sum, r) => sum + regionArea(r), 0) : 0
function contact(a: Point, b: Point, c: Point, d: Point): Point[] {
  const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y, det = dx * ey - dy * ex
  if (Math.abs(det) < 1e-10) return [a, b, c, d].filter(p => distanceToSegment(p, a, b) < 1e-6 && distanceToSegment(p, c, d) < 1e-6)
  const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / det, u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / det
  return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? [{ x: a.x + dx * t, y: a.y + dy * t }] : []
}

export interface RailAccessAcquisition { parcelId: string; roadId: string; railwayId: string; year: number; buildingIds: string[] }

/** One deterministic finalization entry point for generation and saved-world
 * diagnostics. Acquired titles cannot subsequently resurrect the taken paving. */
export function finalizeCivicRoadHistory(map: CityMap) {
  const retained = retainCivicAccess(map), acquired = acquireRailSeveredHoldings(retained.map, retained.unresolved)
  const final = acquired.acquisitions.length ? retainCivicAccess(acquired.map) : retained
  return { map: final.map, retained: acquired.acquisitions.length ? [...retained.retained, ...final.retained] : retained.retained, acquisitions: acquired.acquisitions, unresolved: final.unresolved }
}

/** Explicit fictional project appraisal: if a NEW railway takes every paved
 * connection of an existing holding, the project also acquires that landlocked
 * holding. This is a simulation rule, not a statement about real acquisition law.
 * A clear building pad alone does not establish continued access. */
export function acquireRailSeveredHoldings(map: CityMap, unresolved: UnresolvedCivicAccess[]): { map: CityMap; acquisitions: RailAccessAcquisition[] } {
  const history = map.timeline
  if (!history || !unresolved.length) return { map, acquisitions: [] }
  const acquisitions: RailAccessAcquisition[] = []
  const capacity = (version: TimelineVersion<Building>): number | undefined => {
    const b = version.value
    if (b.use === 'lodging' || b.kind === 'industrial') return 0
    const states = history.buildingStates.filter(s => s.id === b.id && s.from >= version.from && (version.to === undefined || s.from < version.to))
    // An occupied record means all of this building's capacity was used in the
    // original simulation. An underused record identifies multi-household stock.
    const full = states.find(s => s.occupancy === 'occupied' && s.occupiedHouseholds !== undefined)
    if (full) return full.occupiedHouseholds!
    if (states.some(s => s.occupancy === 'underused')) return b.height * 2
    if ((b.builtYear ?? version.from) < 1955) return 1
    if (b.kind === 'residential' && b.height >= 3) return b.height * 2
    // Modern low-rise apartments can have the same geometry as a house. Without
    // an exact state record, do not invent a capacity adjustment or acquisition.
    return undefined
  }
  for (const problem of unresolved) {
    const year = problem.year, original = history.roads.find(v => v.value.id === problem.roadId && v.to === year)
    if (!original) continue
    const railways = history.railways.filter(v => v.from === year && v.value.mode !== 'subway')
    if (!railways.length) continue
    const road = original.value, lengths = [0]
    for (let i = 1; i < road.points.length; i++) lengths.push(lengths[i - 1]! + distance(road.points[i - 1]!, road.points[i]!))
    const along = (p: Point) => {
      let best = { distance: Infinity, along: 0 }
      for (let i = 1; i < road.points.length; i++) {
        const q = projectPoint(p, road.points[i - 1]!, road.points[i]!), d = distance(p, q)
        if (d < best.distance) best = { distance: d, along: lengths[i - 1]! + distance(road.points[i - 1]!, q) }
      }
      return best.along
    }
    const roads = history.roads.filter(v => v.value.id !== road.id && active(v, year) && street(v.value)).map(v => v.value)
    const connections: number[] = []
    for (let i = 1; i < road.points.length; i++) for (const source of roads) for (let j = 1; j < source.points.length; j++) if (overlaps(boundsOf([road.points[i - 1]!, road.points[i]!]), boundsOf([source.points[j - 1]!, source.points[j]!]))) {
      for (const p of contact(road.points[i - 1]!, road.points[i]!, source.points[j - 1]!, source.points[j]!)) connections.push(along(p))
    }
    if (!connections.length) continue // Missing graph provenance is not a rail acquisition.
    for (const parcelId of problem.parcelIds) {
      if (acquisitions.some(a => a.parcelId === parcelId)) continue
      const parcel = history.parcels.find(v => v.value.id === parcelId && v.from < year && active(v, year))
      const standing = history.buildings.filter(v => v.value.parcelId === parcelId && v.from < year && active(v, year))
      if (!parcel || !standing.length) continue
      // Existing private access is a surveyed right, including flag-lot paths
      // outside the main title. Its loss needs separate proof; never assume it
      // vanished merely because the originally assigned public driveway closes.
      if ((parcel.value.access?.length ?? 0) >= 2) continue
      // Any actual alternative public frontage prevents a severance acquisition.
      // We do not fabricate a replacement public route across neighbouring land.
      const alternative = roads.some(r => r.points.slice(1).some((b, i) => {
        const polygon = corridorPolygon(r.points[i]!, b, r.width / 2)
        return crossedArea(parcel.value.polygon, polygon) > .01 || parcel.value.polygon.some(p => pointInRegion(p, { polygon }))
          || parcel.value.polygon.some((p, j) => polygon.some((q, k) => contact(p, parcel.value.polygon[(j + 1) % parcel.value.polygon.length]!, q, polygon[(k + 1) % polygon.length]!).length))
      }))
      if (alternative) continue
      const affected = history.buildings.filter(v => v.value.parcelId === parcelId && (v.to === undefined || v.to > year))
      if (affected.some(v => capacity(v) === undefined)) continue
      const frontage = along(parcel.value.entrance)
      const railway = railways.find(v => {
        // Every original connection must actually lose some full-width paving.
        return connections.every(source => {
          const from = Math.min(source, frontage), to = Math.max(source, frontage)
          return road.points.slice(1).some((b, i) => {
            const lo = Math.max(from, lengths[i]!), hi = Math.min(to, lengths[i + 1]!), length = lengths[i + 1]! - lengths[i]!
            if (hi <= lo + 1e-6) return false
            const a = road.points[i]!, at = (s: number) => ({ x: a.x + (b.x - a.x) * (s - lengths[i]!) / length, y: a.y + (b.y - a.y) * (s - lengths[i]!) / length })
            return pavingFullyTaken(at(lo), at(hi), road.width, v.value, history.terrainSurfaces.find(v => active(v, year))?.value)
          })
        })
      })
      if (!railway) continue
      acquisitions.push({ parcelId, roadId: road.id, railwayId: railway.value.id, year, buildingIds: [...new Set(affected.map(v => v.value.id))] })
    }
  }
  if (!acquisitions.length) return { map, acquisitions }
  const acquired = new Map(acquisitions.map(a => [a.parcelId, a])), buildingAcquired = new Map(acquisitions.flatMap(a => a.buildingIds.map(id => [id, a.year] as const)))
  const clip = <T>(versions: TimelineVersion<T>[], acquire: (v: TimelineVersion<T>) => number | undefined) => versions.flatMap(v => {
    const year = acquire(v)
    if (year === undefined || v.to !== undefined && v.to <= year) return [v]
    return v.from >= year ? [] : [{ ...v, to: year }]
  })
  const buildings = clip(history.buildings, v => acquired.get(v.value.parcelId ?? '')?.year), parcels = clip(history.parcels, v => acquired.get(v.value.id)?.year)
  const grounds = acquisitions.map(a => { const parcel = history.parcels.find(v => v.value.id === a.parcelId && active(v, a.year))!.value
    return { from: a.year, value: { id: `railway-access-acquisition-${a.parcelId}-${a.year}`, kind: 'field' as const, landUse: 'vacant' as const, name: '鉄道事業・接道喪失に伴う取得地', polygon: parcel.polygon } }
  })
  const newEvents: GrowthEvent[] = acquisitions.map(a => ({ id: `event-railway-access-acquisition-${a.parcelId}-${a.year}`, year: a.year, kind: 'acquisition', entityId: a.parcelId,
    reason: `${history.railways.find(v => v.value.id === a.railwayId)!.value.name}の開通に伴い既設通路を鉄道用地に取得。代替の公道接面がない敷地を併せて取得。` }))
  const keepEvent = (e: GrowthEvent) => e.year < (acquired.get(e.entityId)?.year ?? buildingAcquired.get(e.entityId) ?? Infinity)
  const events = [...(map.events ?? []).filter(keepEvent), ...newEvents], datedEvents = [...(history.events ?? map.events ?? []).filter(keepEvent), ...newEvents]
  const snapshots = (values: SimulationSnapshot[] | undefined) => values?.map(s => {
    const removed = history.buildings.filter(v => active(v, s.year) && (acquired.get(v.value.parcelId ?? '')?.year ?? Infinity) <= s.year)
    if (!removed.length) return s
    const remaining = Math.max(0, s.capacity - removed.reduce((n, v) => n + capacity(v)!, 0))
    return { ...s, buildings: Math.max(0, s.buildings - removed.length), capacity: remaining, vacant: Math.max(0, remaining - s.households), unmet: Math.max(0, s.households - remaining) }
  })
  const currentYear = map.year ?? history.throughYear
  return { map: { ...map, buildings: map.buildings.filter(b => (acquired.get(b.parcelId ?? '')?.year ?? Infinity) > currentYear), parcels: map.parcels?.filter(p => (acquired.get(p.id)?.year ?? Infinity) > currentYear),
    areas: [...map.areas, ...grounds.filter(v => active(v, currentYear)).map(v => v.value)], events, snapshots: snapshots(map.snapshots),
    timeline: { ...history, buildings, parcels, areas: [...history.areas, ...grounds], events: datedEvents, snapshots: snapshots(history.snapshots),
      buildingStates: history.buildingStates.filter(s => s.from < (buildingAcquired.get(s.id) ?? Infinity)) } }, acquisitions }
}
