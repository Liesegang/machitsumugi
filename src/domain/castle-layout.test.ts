import { expect, it } from 'vitest'
import { castleLayout } from './castle-layout'
import { intersectRegions, pointInPolygon, polygonOverlapsRegion, polygonsOverlap, regionArea } from './geometry'
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
