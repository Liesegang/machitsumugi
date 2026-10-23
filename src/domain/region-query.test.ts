import { describe, expect, it } from 'vitest'
import { regionQuery } from './region-query'
import type { Point } from './types'

function inside(p: Point, polygon: Point[]) {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}
describe('static exact region queries', () => {
  it('matches ordinary ray casts at all edges, vertices, holes and nearby floating point coordinates', () => {
    const outer = Array.from({ length: 721 }, (_, i) => { const a = i * Math.PI * 2 / 721, r = 700 + Math.cos(a * 7) * 110; return { x: Math.cos(a) * r - 200, y: Math.sin(a) * r - 160 } })
    const hole = [{ x: -220, y: -120 }, { x: -20, y: -120 }, { x: -20, y: 100 }, { x: -220, y: 100 }]
    const overlay = [{ x: -150, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 150 }, { x: -150, y: 150 }]
    const regions = [{ polygon: outer, holes: [hole] }, { polygon: overlay }], indexed = regionQuery(regions)
    const baseline = (p: Point) => regions.some(a => inside(p, a.polygon) && !a.holes?.some(h => inside(p, h)))
    const queries: Point[] = []
    for (let i = 0; i < 20000; i++) queries.push({ x: ((i * 271) % 2601) - 1300, y: ((i * 571) % 2603) - 1300 })
    for (const ring of [outer, hole, overlay]) for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!
      for (const p of [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]) for (const e of [0, -1e-8, 1e-8]) queries.push({ x: p.x + e, y: p.y + e })
    }
    for (const point of queries) expect(indexed(point)).toBe(baseline(point))
    expect(indexed({ x: -100, y: 0 })).toBe(true)
    expect(indexed({ x: -200, y: -100 })).toBe(false)
  })
  it('preserves an open, disconnected set and rejects invalid index dimensions', () => {
    expect(regionQuery([])({ x: 0, y: 0 })).toBe(false)
    expect(() => regionQuery([], 0)).toThrow(RangeError)
    expect(() => regionQuery([], NaN)).toThrow(RangeError)
  })
})
