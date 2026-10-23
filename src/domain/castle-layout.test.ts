import { expect, it } from 'vitest'
import { castleLayout } from './castle-layout'
import { corridorPolygon, intersectRegions, pointInPolygon, polygonOverlapsRegion, polygonsOverlap, regionArea } from './geometry'
import { surveyCastleAccess } from './castle-access'
it('separates surveyed bailey land, continuous moats, dry gates and real structures', () => {
  const castle = castleLayout({ x: 1000, y: 1000 }, 'minato-2026', { x: .1, y: 1 })
  expect(castle.core.length).toBeGreaterThanOrEqual(6)
  expect(castle.structures).toHaveLength(4)
  for (const [i, building] of castle.structures.entries()) {
    expect(building.polygon.every(p => pointInPolygon(p, castle.core))).toBe(true)
    expect(castle.areas.some(region => polygonOverlapsRegion(building.polygon, region))).toBe(false)
    expect(castle.structures.slice(i + 1).some(other => polygonsOverlap(building.polygon, other.polygon))).toBe(false)
  }
  expect(castle.areas.length).toBeLessThan(8)
  expect(castleLayout({ x: 1000, y: 1000 }, 'other-castle').core).not.toEqual(castle.core)
})
it('keeps dry gate crossings through both moats and long wall faces across seeds', () => {
  for (let seed = 0; seed < 24; seed++) {
    const castle = castleLayout({ x: 1000, y: 1000 }, `castle-${seed}`, { x: .4, y: 1 })
    expect(castle.structures).toHaveLength(4)
    for (const crossing of castle.gateCrossings) {
      // Boolean edge contacts can differ by a floating-point ulp after rotation.
      const submerged = castle.areas.flatMap(area => intersectRegions({ polygon: crossing }, area)).reduce((sum, area) => sum + regionArea(area), 0)
      expect(submerged).toBeLessThan(.01)
    }
    for (const [i, a] of castle.enclosures.honmaru.entries()) {
      const b = castle.enclosures.honmaru[(i + 1) % castle.enclosures.honmaru.length]!
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(60)
    }
    expect(castle.structures[0]!.polygon.every(p => pointInPolygon(p, castle.enclosures.honmaru))).toBe(true)
  }
})
it('connects actual gates, both palace courts and keeps without crossing water or structures', () => {
  for (let seed = 0; seed < 24; seed++) {
    const castle = castleLayout({ x: 1000, y: 1000 }, `castle-path-${seed}`, { x: .4, y: 1 })
    const walls = castle.grounds.filter(area => area.id.startsWith('castle-wall-'))
    const visited = new Set<string>(), pending = [castle.paths[0]!.points[0]!]
    const key = (point: { x: number; y: number }) => `${point.x}:${point.y}`
    while (pending.length) {
      const point = pending.pop()!
      if (visited.has(key(point))) continue
      visited.add(key(point))
      for (const road of castle.paths) for (let i = 1; i < road.points.length; i++) {
        if (key(road.points[i - 1]!) === key(point)) pending.push(road.points[i]!)
        if (key(road.points[i]!) === key(point)) pending.push(road.points[i - 1]!)
      }
    }
    for (const road of castle.paths) {
      expect(road.builtYear).toBe(1650)
      expect(road.points.every(point => visited.has(key(point)))).toBe(true)
      for (let i = 1; i < road.points.length; i++) {
        const polygon = corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2)
        expect(polygon.every(point => pointInPolygon(point, castle.core))).toBe(true)
        expect([...castle.areas, ...walls].some(area => polygonOverlapsRegion(polygon, area))).toBe(false)
        expect(castle.structures.some(building => polygonsOverlap(polygon, building.polygon))).toBe(false)
      }
    }
    expect(castle.grounds.filter(area => area.id.startsWith('castle-courtyard-'))).toHaveLength(2)
    expect(walls.length).toBeGreaterThan(0)
  }
})
it('surveys a real founding-street approach and does not assert a future or submerged gate connection', () => {
  const castle = castleLayout({ x: 800, y: 700 }, 'castle-approach'), gate = castle.gate.outside
  const roads = [{ id: 'old-street', points: [{ x: gate.x - 250, y: gate.y + 100 }, { x: gate.x + 250, y: gate.y + 100 }], kind: 'local' as const, width: 6, builtYear: 1650 }]
  const terrain = { elevation: () => 20, slope: () => 0, waterAt: () => false, bridgeSites: [] }
  const input = { castle, width: 1600, height: 1400, roads, areas: castle.areas, terrain }
  const approach = surveyCastleAccess(input)
  expect(approach).not.toBeNull()
  expect(approach!.road.points.at(-1)).toEqual(castle.paths[0]!.points[0])
  expect(approach!.attach.roadId).toBe('old-street')
  expect(approach!.cost).toBeGreaterThan(0)
  expect(approach!.road.bridge).not.toBe(true)
  expect(surveyCastleAccess({ ...input, roads: roads.map(road => ({ ...road, builtYear: 1900 })) })).toBeNull()
  expect(surveyCastleAccess({ ...input, terrain: { ...terrain, waterAt: () => true } })).toBeNull()
})
