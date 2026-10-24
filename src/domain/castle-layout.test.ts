import { expect, it } from 'vitest'
import { castleLayout } from './castle-layout'
import { corridorPolygon, distance, intersectRegions, pointInRegion, regionArea } from './geometry'
import { surveyCastleAccess } from './castle-access'
import { affineRingSignature, castleShapeSignature, expectCastlePhysicalGeometry } from './test-support/castle-audit'

it('detects a polygon template even after translation, rotation, shear and anisotropic scale', () => {
  const octagon = Array.from({ length: 8 }, (_, i) => ({ x: Math.cos(i * Math.PI / 4), y: Math.sin(i * Math.PI / 4) }))
  const stretched = octagon.map(p => ({ x: 120 + p.x * 40 + p.y * 7, y: 50 + p.y * 20 }))
  expect(affineRingSignature(stretched)).toBe(affineRingSignature(octagon))
})

it('builds three distinct occupied compounds with real dry gate routes rather than one enclosing ring icon', () => {
  for (const seed of ['minato-2026', 'castle-0', 'castle-7', 'castle-14', 'castle-23']) {
    const castle = castleLayout({ x: 1000, y: 1000 }, seed, { x: .4, y: 1 })
    expectCastlePhysicalGeometry(castle)
    expect(castleLayout({ x: 1000, y: 1000 }, seed, { x: .4, y: 1 })).toEqual(castle)
  }
})

it('varies compound plans and moat proportions beyond a global affine copy across seeds', () => {
  const castles = Array.from({ length: 8 }, (_, i) => castleLayout({ x: 1000, y: 1000 }, `castle-plan-${i}`, { x: .4, y: 1 }))
  expect(new Set(castles.map(castleShapeSignature)).size).toBeGreaterThanOrEqual(3)
  const moatRatios = castles.map(c => {
    const moatArea = c.areas.reduce((sum, a) => sum + regionArea(a), 0), inner = c.enclosures.honmaru
    const baileyArea = Math.abs(inner.reduce((sum, p, i) => { const q = inner[(i + 1) % inner.length]!; return sum + p.x * q.y - q.x * p.y }, 0)) / 2
    return Math.round(moatArea / baileyArea * 10_000)
  })
  expect(new Set(moatRatios).size).toBeGreaterThanOrEqual(3)
  const wetBoundaryCoverage = castles.map(c => {
    const ring = c.enclosures.honmaru, signed = ring.reduce((n, p, i) => { const q = ring[(i + 1) % ring.length]!; return n + p.x * q.y - q.x * p.y }, 0), outward = signed > 0 ? 1 : -1
    let total = 0, wet = 0
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!, length = distance(a, b), count = Math.ceil(length / 5)
      for (let j = 0; j < count; j++) {
        const p = { x: a.x + (b.x - a.x) * (j + .5) / count, y: a.y + (b.y - a.y) * (j + .5) / count }
        total++
        if ([6, 12, 20, 30].some(offset => c.areas.some(w => pointInRegion({ x: p.x + (b.y - a.y) / length * offset * outward, y: p.y - (b.x - a.x) / length * offset * outward }, w)))) wet++
      }
    }
    return wet / total
  })
  // A near-complete constant offset ring can pass angle/seed inequality tests.
  // At least some inherited plans must have genuinely dry defensive sides.
  expect(wetBoundaryCoverage.filter(coverage => coverage < .9).length).toBeGreaterThanOrEqual(2)
})

it('connects the outer compound to an actual founding street without inventing water crossings or future access', () => {
  const castle = castleLayout({ x: 800, y: 700 }, 'castle-approach'), gate = castle.gate.outside
  const roads = [{ id: 'old-street', points: [{ x: gate.x - 250, y: gate.y + 100 }, { x: gate.x + 250, y: gate.y + 100 }], kind: 'local' as const, width: 6, builtYear: 1650 }]
  const terrain = { elevation: () => 20, slope: () => 0, waterAt: () => false, bridgeSites: [] }
  const input = { castle, width: 1600, height: 1400, roads, areas: castle.areas, terrain }
  const approach = surveyCastleAccess(input)
  expect(approach).not.toBeNull()
  expect(approach!.road.points.at(-1)).toEqual(castle.gate.inside)
  expect(approach!.attach.roadId).toBe('old-street')
  expect(approach!.road.builtYear).toBe(1650)
  expect(approach!.cost).toBeGreaterThan(0)
  expect(approach!.road.bridge).not.toBe(true)
  for (let i = 1; i < approach!.road.points.length; i++) {
    const paving = corridorPolygon(approach!.road.points[i - 1]!, approach!.road.points[i]!, approach!.road.width / 2)
    for (const water of castle.areas) expect(intersectRegions({ polygon: paving }, water).reduce((n, r) => n + regionArea(r), 0)).toBeLessThan(.01)
  }
  expect(surveyCastleAccess({ ...input, roads: roads.map(road => ({ ...road, builtYear: 1900 })) })).toBeNull()
  expect(surveyCastleAccess({ ...input, terrain: { ...terrain, waterAt: () => true } })).toBeNull()
})
