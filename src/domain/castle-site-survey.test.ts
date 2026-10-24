import { describe, expect, it } from 'vitest'
import { corridorPolygon, intersectRegions, pointInPolygon, pointInRegion, polygonsOverlap, rectangle, regionArea } from './geometry'
import { surveyCastleLayout } from './castle-layout'
import { castleShapeSignature, expectCastlePhysicalGeometry } from './test-support/castle-audit'
import type { Point } from './types'
import { waterSurfaceElevation } from '../map/water-surfaces'
import { RoadPlanner } from './road-planner'

const origin = { x: 900, y: 800 }, flat = { elevation: () => 30, slope: () => 0, waterAt: (_point: Point) => false }
const site = { width: 1800, height: 1600, terrain: flat }

describe('terrain-dependent castle enclosure survey', () => {
  it('keeps separate wet moats and exact dry gate cuts on a level terrace', () => {
    const castle = surveyCastleLayout(origin, 'terrace', site)!
    expect(castle).not.toBeNull()
    expectCastlePhysicalGeometry(castle)
    expect(castle.survey.waterMoats).toBeGreaterThan(0)
    expect(castle.survey.dryDitches).toBe(0)
    for (const area of castle.areas) expect(Number.isFinite(area.waterLevel)).toBe(true)
    for (const crossing of castle.gateCrossings) expect(castle.areas.flatMap(area => intersectRegions({ polygon: crossing }, area)).reduce((sum, region) => sum + regionArea(region), 0)).toBeLessThan(.01)
    expect(surveyCastleLayout(origin, 'terrace', site)).toEqual(castle)
    // The production survey must retain the historical enclosure's identity;
    // testing only context-free castleLayout missed identical castles on flat
    // land after the survey started supplying every transform parameter.
    const other = surveyCastleLayout(origin, 'other-terrace', site)!
    expect(other.core).not.toEqual(castle.core)
    expect(castleShapeSignature(other)).not.toBe(castleShapeSignature(castle))
    expect(other.structures.map(building => building.polygon)).not.toEqual(castle.structures.map(building => building.polygon))
    for (const building of other.structures) expect(building.polygon.every(point => pointInPolygon(point, other.core))).toBe(true)
    for (const crossing of other.gateCrossings) expect(other.areas.flatMap(area => intersectRegions({ polygon: crossing }, area)).reduce((sum, region) => sum + regionArea(region), 0)).toBeLessThan(.01)
  })
  it('follows a contour terrace, puts the gate below the keep, and uses dry ditches on a sloping ridge', () => {
    const terrain = { elevation: (p: Point) => 40 + (p.y - origin.y) * .045, slope: () => .045, waterAt: () => false }
    const castle = surveyCastleLayout(origin, 'ridge', { ...site, terrain })!
    expect(castle).not.toBeNull()
    expectCastlePhysicalGeometry(castle)
    expect(castle.survey.scaleX).toBeGreaterThan(castle.survey.scaleY * 1.4)
    expect(terrain.elevation(castle.gate.outside)).toBeLessThan(terrain.elevation(castle.point))
    expect(castle.survey.dryDitches).toBeGreaterThan(0)
    for (const area of castle.areas) {
      const levels = area.polygon.map(point => terrain.elevation(point))
      expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(2.5)
      expect(Number.isFinite(area.waterLevel)).toBe(true)
      expect(new Set(area.polygon.map(point => waterSurfaceElevation(area, point, terrain.elevation))).size).toBe(1)
      expect(waterSurfaceElevation(area, area.polygon[0]!, terrain.elevation)).toBeLessThanOrEqual(Math.min(...levels) - .5 + 1e-8)
    }
    expect(castle.grounds.some(area => area.id.startsWith('castle-dry-ditch-'))).toBe(true)
  })
  it('rotates the entire enclosure when the geographic slope rotates', () => {
    const east = surveyCastleLayout(origin, 'ridge', { ...site, terrain: { ...flat, slope: () => .045, elevation: (p: Point) => 40 + (p.x - origin.x) * .045 } })!
    const south = surveyCastleLayout(origin, 'ridge', { ...site, terrain: { ...flat, slope: () => .045, elevation: (p: Point) => 40 + (p.y - origin.y) * .045 } })!
    const vector = (castle: typeof east) => ({ x: castle.gate.outside.x - castle.point.x, y: castle.gate.outside.y - castle.point.y })
    expect(vector(east).x).toBeLessThan(-150)
    expect(vector(south).y).toBeLessThan(-150)
    expect(east.core).not.toEqual(south.core)
  })
  it('preserves real path clearances at the gates, walls and palaces after a terrace is narrowed and rotated', () => {
    for (const angle of [0, Math.PI / 3, Math.PI / 2, Math.PI]) {
      const terrain = { ...flat, slope: () => .045, elevation: (p: Point) => 40 + ((p.x - origin.x) * Math.cos(angle) + (p.y - origin.y) * Math.sin(angle)) * .045 }
      const castle = surveyCastleLayout(origin, 'clearance', { ...site, terrain })!
      expectCastlePhysicalGeometry(castle)
      const planner = new RoadPlanner({ width: site.width, height: site.height, core: null, areas: castle.areas, terrain: { ...terrain, bridgeSites: [], waterAt: point => terrain.waterAt(point) || castle.areas.some(area => pointInRegion(point, area)) } })
      // This is the same acceptance gate used by generator.ts before inserting
      // each road. No emitted branch may silently disappear at integration.
      expect(castle.paths.every(path => planner.validate(path.points, path.width))).toBe(true)
      const walls = castle.grounds.filter(area => area.id.startsWith('castle-wall-'))
      for (const path of castle.paths) for (let i = 1; i < path.points.length; i++) {
        const polygon = corridorPolygon(path.points[i - 1]!, path.points[i]!, path.width / 2)
        expect(polygon.every(point => pointInPolygon(point, castle.core))).toBe(true)
        expect(castle.structures.some(building => polygonsOverlap(polygon, building.polygon))).toBe(false)
        const intersection = [...castle.areas, ...walls].flatMap(area => intersectRegions({ polygon }, area)).reduce((sum, region) => sum + regionArea(region), 0)
        expect(intersection).toBeLessThan(.01)
      }
    }
  })
  it('rejects an actual thin tributary crossing the reserved land even between numerical sample rows', () => {
    const water = { id: 'thin-creek', kind: 'water' as const, polygon: rectangle(origin.x - 2, 0, 1, 1600) }
    expect(surveyCastleLayout(origin, 'thin-creek', { ...site, waterAreas: [water] })).toBeNull()
  })
  it('does not invent a castle on water, steep terrain, a deep hollow or outside the map', () => {
    expect(surveyCastleLayout(origin, 'water', { ...site, terrain: { ...flat, waterAt: () => true } })).toBeNull()
    expect(surveyCastleLayout(origin, 'steep', { ...site, terrain: { ...flat, slope: () => .3 } })).toBeNull()
    expect(surveyCastleLayout(origin, 'nan', { ...site, terrain: { ...flat, slope: () => NaN } })).toBeNull()
    expect(surveyCastleLayout(origin, 'hole', { ...site, terrain: { ...flat, elevation: (p: Point) => Math.hypot(p.x - origin.x, p.y - origin.y) < 70 ? -80 : 30 } })).toBeNull()
    expect(surveyCastleLayout({ x: 12, y: 12 }, 'edge', site)).toBeNull()
  })
})
