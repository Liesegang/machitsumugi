import type { Building, Point, Railway, Road, Station, TimelineVersion } from './types'
import { distanceToSegment, pointInPolygon, polygonsOverlap, segmentsCross } from './geometry'

interface StationArchitectureInput {
  stations: Station[]; railways: Railway[]; roads: Road[]
  buildings?: Building[]; buildingVersions?: TimelineVersion<Building>[]
  width: number; height: number
  waterAt: (point: Point) => boolean; slope: (point: Point) => number; elevation: (point: Point) => number
}

type ArchitecturalStation = Station & { railwayId?: string; mode?: 'surface' | 'subway'; builtYear?: number; buildingPolygon?: Point[]; entrance?: Point }
type ArchitecturalRailway = Railway & { mode?: 'surface' | 'subway' }
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y

/** Pure survey shared by generation and legacy 3D maps. It allocates no land by
 * painting over a house: a footprint must be clear for its full known lifetime. */
export function surveyStationArchitecture(input: StationArchitectureInput): Station[] {
  const reserved: Point[][] = []
  return input.stations.map((value): Station => {
    const station = value as ArchitecturalStation
    let nearest: { line: ArchitecturalRailway; point: Point; tangent: Point; distance: number } | undefined
    for (const line of input.railways as ArchitecturalRailway[]) {
      if (station.railwayId && station.railwayId !== line.id) continue
      for (let i = 1; i < line.points.length; i++) {
        const a = line.points[i - 1]!, b = line.points[i]!, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy)
        if (length < .01) continue
        const t = Math.max(0, Math.min(1, ((station.point.x - a.x) * dx + (station.point.y - a.y) * dy) / (length * length))), point = { x: a.x + dx * t, y: a.y + dy * t }, distance = Math.hypot(point.x - station.point.x, point.y - station.point.y)
        if (!nearest || distance < nearest.distance) nearest = { line, point, tangent: { x: dx / length, y: dy / length }, distance }
      }
    }
    if (!nearest || nearest.distance > 90) return station
    const subway = station.mode === 'subway' || nearest.line.mode === 'subway', inception = station.builtYear ?? nearest.line.builtYear ?? 1900
    let tangent = nearest.tangent, center = nearest.point, roadHalfWidth = 0
    if (subway && station.entrance) {
      // A tunnel station's platform may be far below the street it serves.
      // Survey the actual pedestrian entrance, not a second surface station.
      let entranceRoad: { point: Point; tangent: Point; width: number; distance: number } | undefined
      for (const road of input.roads) if (!road.controlledAccess && (road.level ?? 0) === 0 && road.role !== 'expressway' && road.role !== 'ramp') for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1]!, b = road.points[i]!, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy)
        if (length < .01) continue
        const t = Math.max(0, Math.min(1, ((station.entrance.x - a.x) * dx + (station.entrance.y - a.y) * dy) / (length * length))), point = { x: a.x + dx * t, y: a.y + dy * t }, distance = Math.hypot(point.x - station.entrance.x, point.y - station.entrance.y)
        if (!entranceRoad || distance < entranceRoad.distance) entranceRoad = { point, tangent: { x: dx / length, y: dy / length }, width: road.width, distance }
      }
      if (entranceRoad && entranceRoad.distance < 80) { center = entranceRoad.point; tangent = entranceRoad.tangent; roadHalfWidth = entranceRoad.width / 2 }
      else center = station.entrance
    }
    const normal = { x: -tangent.y, y: tangent.x }
    const transform = (x: number, y: number): Point => ({ x: center.x + tangent.x * x + normal.x * y, y: center.y + tangent.y * x + normal.y * y })
    const obstacles = input.buildingVersions ? input.buildingVersions.filter(version => version.to === undefined || version.to > inception).map(version => version.value.polygon) : (input.buildings ?? []).map(building => building.polygon)
    const crossed = (polygon: Point[], a: Point, b: Point, clearance: number) => pointInPolygon(a, polygon) || pointInPolygon(b, polygon) || polygon.some((p, i) => distanceToSegment(p, a, b) < clearance || distanceToSegment(a, p, polygon[(i + 1) % polygon.length]!) < clearance || distanceToSegment(b, p, polygon[(i + 1) % polygon.length]!) < clearance || segmentsCross(p, polygon[(i + 1) % polygon.length]!, a, b))
    const clear = (polygon: Point[]) => {
      if (polygon.some(p => p.x < 2 || p.y < 2 || p.x > input.width - 2 || p.y > input.height - 2)) return false
      if (obstacles.some(obstacle => polygonsOverlap(polygon, obstacle)) || reserved.some(obstacle => polygonsOverlap(polygon, obstacle))) return false
      for (const road of input.roads) for (let i = 1; i < road.points.length; i++) if (crossed(polygon, road.points[i - 1]!, road.points[i]!, road.width / 2 + .8)) return false
      for (const line of input.railways as ArchitecturalRailway[]) if (line.mode !== 'subway') for (let i = 1; i < line.points.length; i++) if (crossed(polygon, line.points[i - 1]!, line.points[i]!, 3.5)) return false
      const samples = [...polygon]
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2)
        for (let n = 1; n < steps; n++) samples.push({ x: a.x + (b.x - a.x) * n / steps, y: a.y + (b.y - a.y) * n / steps })
      }
      samples.push(polygon.reduce((sum, p) => ({ x: sum.x + p.x / polygon.length, y: sum.y + p.y / polygon.length }), { x: 0, y: 0 }))
      if (samples.some(p => input.waterAt(p) || input.slope(p) > .12)) return false
      const levels = samples.map(input.elevation)
      return Math.max(...levels) - Math.min(...levels) <= (subway ? 1 : 2)
    }
    const base = { ...station, railwayId: nearest.line.id, ...(subway ? { mode: 'subway' as const } : {}) }
    if (station.buildingPolygon && clear(station.buildingPolygon)) { reserved.push(station.buildingPolygon); return base }
    const preferred = station.entrance ? Math.sign(dot({ x: station.entrance.x - center.x, y: station.entrance.y - center.y }, normal)) || 1 : 1
    for (const length of subway ? [6, 4.5] : [30, 22, 16, 10]) for (const side of [preferred, -preferred]) for (const shift of [0, -18, 18]) {
      const depth = subway ? 3 : length >= 22 ? 9 : 6, setback = subway ? roadHalfWidth + 1.2 : 8, offset = side * (setback + depth / 2)
      const polygon = [[-length / 2, -depth / 2], [length / 2, -depth / 2], [length / 2, depth / 2], [-length / 2, depth / 2]].map(([x, y]) => transform(x! + shift, y! + offset))
      if (!clear(polygon)) continue
      reserved.push(polygon)
      return { ...base, buildingPolygon: polygon, entrance: transform(shift, offset + (subway ? -side : side) * depth / 2) }
    }
    // Preserve the station itself and platforms; no feasible building lot is a
    // valid result, rather than permission to invent a reclaimed site.
    const { buildingPolygon: _building, ...withoutBuilding } = base
    return withoutBuilding
  })
}
