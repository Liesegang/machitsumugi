import { difference, union } from 'polygon-clipping'
import ClipperLib from 'clipper-lib'
import type { PolyNode } from 'clipper-lib'
import type { Area, Building, CityConfig, Parcel, Point, Road } from './types'
import type { Bounds, PolygonRegion } from './geometry'
import type { TerrainModel } from './terrain'
import type { LayoutFirstZone } from './layout-first-types'
import { boundsOf, corridorPolygon, distance, overlaps, pathPointAt, pointInRegion, polygonArea, polygonOverlapsRegion, rectangle, regionArea, seededRandom, subtractRegions } from './geometry'
import { agriculturalUse } from './land-use'
import { controlledRoad } from './road-graph'

type ClipPolygon = [number, number][][]
type ClipMultiPolygon = ClipPolygon[]
export type LayoutCoverTerrain = Pick<TerrainModel, 'areas' | 'elevation' | 'slope' | 'wetness' | 'waterAt'> & Partial<Pick<TerrainModel, 'channelAt' | 'rivers' | 'cultivable'>>
export interface LayoutFirstCoverInput {
  config: CityConfig; width: number; height: number; terrain: LayoutCoverTerrain
  zones: LayoutFirstZone[]; parcels: Parcel[]; roads: Road[]; reserves?: PolygonRegion[]; buildings?: Building[]
}
interface IndexedRegion extends PolygonRegion { bounds: Bounds }
function index(regions: PolygonRegion[], size = 200) {
  const cells = new Map<string, IndexedRegion[]>()
  const indexed = regions.map(region => ({ ...region, bounds: boundsOf(region.polygon) }))
  for (const region of indexed) for (let x = Math.floor(region.bounds.minX / size); x <= Math.floor(region.bounds.maxX / size); x++) for (let y = Math.floor(region.bounds.minY / size); y <= Math.floor(region.bounds.maxY / size); y++) { const key = `${x}:${y}`, list = cells.get(key) ?? []; list.push(region); cells.set(key, list) }
  return (bounds: Bounds) => {
    const found = new Set<IndexedRegion>()
    for (let x = Math.floor(bounds.minX / size); x <= Math.floor(bounds.maxX / size); x++) for (let y = Math.floor(bounds.minY / size); y <= Math.floor(bounds.maxY / size); y++) for (const region of cells.get(`${x}:${y}`) ?? []) if (overlaps(bounds, region.bounds)) found.add(region)
    return [...found]
  }
}
const clip = (region: PolygonRegion): ClipPolygon => [region.polygon, ...(region.holes ?? [])].map(ring => [...ring, ring[0]!].map(p => [Math.round(p.x * 10000) / 10000, Math.round(p.y * 10000) / 10000]))
function regions(geometry: ClipMultiPolygon): PolygonRegion[] {
  return geometry.map(rings => ({ polygon: rings[0]!.slice(0, -1).map(([x, y]) => ({ x, y })), ...(rings.length > 1 ? { holes: rings.slice(1).map(ring => ring.slice(0, -1).map(([x, y]) => ({ x, y }))) } : {}) })).filter(region => region.polygon.length >= 3 && regionArea(region) > .1)
}
/** Clipping is performed once per natural region, rather than once per title. */
export function removeLayoutCoverRegions(region: PolygonRegion, obstacles: PolygonRegion[]) {
  const bounds = boundsOf(region.polygon), nearby = obstacles.filter(other => overlaps(bounds, boundsOf(other.polygon)))
  if (!nearby.length) return [region]
  try { return regions(difference(clip(region), ...nearby.map(clip))) }
  catch { return subtractRegions(region, nearby) }
}
export function mergeLayoutCoverRegions(regionsToMerge: PolygonRegion[]) {
  if (!regionsToMerge.length) return []
  try { return regions(union(regionsToMerge.map(clip))) }
  catch { return regionsToMerge }
}
/** One surveyed road strip, rather than thousands of overlapping sample caps. */
export function layoutRoadClearance(road: Road): PolygonRegion[] {
  const scale = 1000, path = road.points.map(p => ({ X: Math.round(p.x * scale), Y: Math.round(p.y * scale) }))
  if (path.length < 2) return []
  const offset = new ClipperLib.ClipperOffset(2, 50), tree = new ClipperLib.PolyTree()
  offset.AddPath(path, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etOpenSquare)
  offset.Execute(tree, (road.width / 2 + .6) * scale)
  const result: PolygonRegion[] = [], ring = (node: PolyNode) => node.Contour().map(p => ({ x: p.X / scale, y: p.Y / scale }))
  const visit = (node: PolyNode) => {
    if (!node.IsHole() && node.Contour().length >= 3) result.push({ polygon: ring(node), holes: node.Childs().filter(child => child.IsHole()).map(ring) })
    for (const child of node.Childs()) visit(child)
  }
  visit(tree)
  return result
}
const samples = (polygon: Point[]) => polygon.flatMap((a, i) => { const b = polygon[(i + 1) % polygon.length]!, count = Math.max(1, Math.ceil(distance(a, b) / 10)); return Array.from({ length: count }, (_, j) => ({ x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count })) })

/**
 * Reuse the terrain's continuous natural boundaries, and actually clear adopted
 * urban ground. There is no second fine raster, nor a map-wide field lattice.
 * Farm holdings are surveyed only beside real rural/peripheral road frontage.
 */
export function buildLayoutFirstCover(input: LayoutFirstCoverInput): Area[] {
  const { terrain, width, height, config } = input, crop = { polygon: rectangle(0, 0, width, height) }
  const water = terrain.areas.filter(area => area.kind === 'water')
  const natural = terrain.areas.filter(area => area.kind !== 'water')
  const privateGround: PolygonRegion[] = [...input.parcels.filter(p => p.retiredYear === undefined).map(parcel => ({ polygon: parcel.polygon })), ...(input.reserves ?? []), ...(input.buildings ?? []).map(building => ({ polygon: building.polygon }))]
  const clearings = [...privateGround]
  for (const road of input.roads) if ((road.level ?? 0) === 0) clearings.push(...layoutRoadClearance(road))
  const mergedClearings = mergeLayoutCoverRegions(clearings), clearingQuery = index(mergedClearings)
  const exclusions = index([...clearings, ...water, ...natural.filter(area => area.kind === 'forest')])
  const accessExclusions = index([...privateGround, ...water, ...natural.filter(area => area.kind === 'forest')])
  const farmAreas: Area[] = [], farmBounds: Bounds[] = []
  const maximumFields = Math.min(900, Math.max(24, Math.ceil(width * height / 70000)))
  const agricultureTerrain = { elevation: terrain.elevation, slope: terrain.slope, wetness: terrain.wetness, channelAt: terrain.channelAt ?? (() => null), rivers: terrain.rivers, cultivable: terrain.cultivable }
  const farmRoads = input.roads.filter(road => !controlledRoad(road) && (road.level ?? 0) === 0 && road.role !== 'bridge').sort((a, b) => Number(b.role === 'farm') - Number(a.role === 'farm') || a.id.localeCompare(b.id))
  for (const road of farmRoads) {
    if (farmAreas.length >= maximumFields) break
    const length = road.points.slice(1).reduce((sum, point, i) => sum + distance(road.points[i]!, point), 0)
    if (length < 75) continue
    const random = seededRandom(`${config.seed}:layout-farm:${road.id}`), count = Math.max(1, Math.floor(length / 110))
    for (let serial = 0; serial < count && farmAreas.length < maximumFields; serial++) {
      const t = (serial + .5) / count, origin = pathPointAt(road.points, t)
      // One survey bearing belongs to a long road/terrace reach; little bends
      // never rotate every individual field into a decorative fan.
      const reach = Math.floor(t * length / 900), from = pathPointAt(road.points, Math.max(0, reach * 900 / length)), to = pathPointAt(road.points, Math.min(1, (reach + 1) * 900 / length))
      const bearing = Math.atan2(to.y - from.y, to.x - from.x), along = { x: Math.cos(bearing), y: Math.sin(bearing) }
      for (const side of [-1, 1]) {
        if (farmAreas.length >= maximumFields) break
        const normal = { x: -along.y * side, y: along.x * side }, fieldWidth = 48 + random() * 35, fieldDepth = 25 + random() * 20
        const world = (u: number, v: number): Point => ({ x: origin.x + along.x * u + normal.x * v, y: origin.y + along.y * u + normal.y * v })
        const start = road.width / 2 + 2, center = world(0, start + fieldDepth / 2)
        // Retain rural farmland, but do not fill station/old-town interiors with
        // unconnected fields merely because a household loop left a vacancy.
        if (input.zones.some(zone => zone.kind !== 'rural' && pointInRegion(center, zone) && distance(center, zone.center) < zone.radius * .86)) continue
        const gx = (terrain.elevation({ x: center.x + 20, y: center.y }) - terrain.elevation({ x: center.x - 20, y: center.y })) / 40
        const gy = (terrain.elevation({ x: center.x, y: center.y + 20 }) - terrain.elevation({ x: center.x, y: center.y - 20 })) / 40
        // Steeper cross-road holdings need a separately surveyed terrace. This
        // fast composition never claims that randomly rotated plots have one.
        if (Math.abs(gx * normal.x + gy * normal.y) * fieldDepth > 2.8) continue
        const polygon = [world(-fieldWidth / 2, start), world(fieldWidth / 2, start), world(fieldWidth / 2, start + fieldDepth), world(-fieldWidth / 2, start + fieldDepth)]
        const bounds = boundsOf(polygon)
        if (bounds.minX < 1 || bounds.minY < 1 || bounds.maxX > width - 1 || bounds.maxY > height - 1) continue
        if (exclusions(bounds).some(region => polygonOverlapsRegion(polygon, region)) || farmBounds.some((b, i) => overlaps(bounds, b) && polygonOverlapsRegion(polygon, farmAreas[i]!))) continue
        const sites = [...samples(polygon), center]
        if (sites.some(p => terrain.waterAt(p) || terrain.slope(p) > .085 || terrain.wetness(p) > .8 || terrain.cultivable?.(p) === false)) continue
        // The frontage touches a real road verge; no invented farm-access route
        // is assumed across another owner's land or across a river.
        const frontage = world(0, start), access = corridorPolygon(origin, frontage, 1.4)
        if (accessExclusions(boundsOf(access)).some(region => polygonOverlapsRegion(access, region)) || samples(access).some(p => terrain.waterAt(p) || terrain.slope(p) > .12)) continue
        const landUse = agriculturalUse(polygon, agricultureTerrain)
        farmAreas.push({ id: `layout-field-${road.id}-${serial}-${side}`, kind: 'field', landUse, polygon }); farmBounds.push(bounds)
      }
    }
  }
  const cover: Area[] = []
  for (const area of natural) {
    const cuts = clearingQuery(boundsOf(area.polygon))
    const parts = removeLayoutCoverRegions(area, cuts).filter(part => regionArea(part) >= (area.kind === 'forest' ? 1200 : 80)).sort((a, b) => regionArea(b) - regionArea(a))
    for (const [i, part] of parts.entries()) {
      const woodland = area.kind === 'forest' && regionArea(part) < 18000
      cover.push({ ...area, ...part, holes: part.holes, id: `land-layout-${area.id}-${i}`, ...(woodland ? { kind: 'park', landUse: 'woodland', name: undefined } : i ? { name: undefined } : {}) })
    }
  }
  const meadow = removeLayoutCoverRegions(crop, [...mergedClearings, ...water, ...cover, ...farmAreas]).filter(part => regionArea(part) > 40).map((part, i): Area => ({ id: `land-layout-meadow-${i}`, kind: 'park', landUse: 'meadow', ...part }))
  // Preserve exact named water geometry/levels and natural forest interfaces.
  // Painter order is also an explicit semantic partition: no ground cover
  // survives inside water, acquired urban titles or reserved civic campuses.
  return [...meadow, ...cover, ...farmAreas, ...water]
}

/** Report actual cover extents without counting hole rings as filled land. */
export const layoutCoverArea = (areas: Area[], landUse: Area['landUse']) => areas.filter(area => area.landUse === landUse).reduce((sum, area) => sum + polygonArea(area.polygon) - (area.holes ?? []).reduce((n, hole) => n + polygonArea(hole), 0), 0)
