import { describe, expect, it } from 'vitest'
import { routeAcrossBridges } from './bridge-routing'
import type { BridgeRoutingInput } from './bridge-routing'
import type { Point } from './types'
import type { PlannedRoute } from './road-planner'

const length = (points: Point[]) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y), 0)
const route = (points: Point[], cost = length(points)): PlannedRoute => ({ points, cost, length: length(points), bridgeLength: 0, method: 'direct' })
const options = { role: 'collector' as const, width: 8 }

describe('surveyed bridge macro routing', () => {
  it('chains two surveyed crossings where one bridge cannot reach the destination', () => {
    const zones = (p: Point) => p.x <= 90 ? 0 : p.x >= 110 && p.x <= 190 ? 1 : p.x >= 210 ? 2 : -1
    const input: BridgeRoutingInput = {
      ...options, start: { x: 0, y: 0 }, goal: { x: 300, y: 0 },
      pairs: [{ a: { x: 90, y: 0 }, b: { x: 110, y: 0 } }, { a: { x: 190, y: 0 }, b: { x: 210, y: 0 } }],
      dry: (a, b) => zones(a) === zones(b) ? route([a, b]) : null,
      cost: points => route(points, length(points) * 13 + 420),
    }
    const result = routeAcrossBridges(input)!
    expect(result.points).toEqual([{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 110, y: 0 }, { x: 190, y: 0 }, { x: 210, y: 0 }, { x: 300, y: 0 }])
    expect(result.cost).toBe(260 + 40 * 13 + 2 * 420)
    expect(result.surveyedBridgeSpans).toEqual([{ bankA: { x: 90, y: 0 }, bankB: { x: 110, y: 0 } }, { bankA: { x: 190, y: 0 }, bankB: { x: 210, y: 0 } }])
    expect(routeAcrossBridges({ ...input, pairs: input.pairs.slice(0, 1) })).toBeNull()
  })
  it('aligns both dry approaches with bridge direction, including reverse crossings', () => {
    const calls: { a: Point; b: Point; start?: number; end?: number }[] = []
    const result = routeAcrossBridges({ ...options, start: { x: 200, y: 10 }, goal: { x: 0, y: 10 }, startHeading: Math.PI, endHeading: Math.PI,
      pairs: [{ a: { x: 90, y: 10 }, b: { x: 110, y: 10 } }],
      dry: (a, b, start, end) => { calls.push({ a, b, start, end }); return (a.x >= 110) === (b.x >= 110) ? route([a, b]) : null }, cost: points => route(points),
    })!
    expect(result.points).toEqual([{ x: 200, y: 10 }, { x: 110, y: 10 }, { x: 90, y: 10 }, { x: 0, y: 10 }])
    expect(result.surveyedBridgeSpans).toEqual([{ bankA: { x: 110, y: 10 }, bankB: { x: 90, y: 10 } }])
    expect(calls.some(c => c.a.x === 200 && c.b.x === 110 && c.start === Math.PI && c.end === Math.PI)).toBe(true)
    expect(calls.some(c => c.a.x === 90 && c.b.x === 0 && c.start === Math.PI && c.end === Math.PI)).toBe(true)
  })
  it('chooses total construction cost rather than the nearest available bridge', () => {
    const result = routeAcrossBridges({ ...options, start: { x: 0, y: 0 }, goal: { x: 200, y: 0 },
      pairs: [{ a: { x: 90, y: 0 }, b: { x: 110, y: 0 } }, { a: { x: 90, y: 80 }, b: { x: 110, y: 80 } }],
      dry: (a, b) => (a.x <= 90) === (b.x <= 90) ? route([a, b]) : null,
      cost: points => route(points, length(points) + (points.length === 2 && points[0]!.y === 0 ? 1000 : 0)),
    })!
    expect(result.points.some(p => p.y === 80)).toBe(true)
    expect(result.cost).toBeLessThan(300)
  })
  it('requires an actual bridge and checks coincident-bank heading compatibility', () => {
    const input: BridgeRoutingInput = { ...options, start: { x: 0, y: 0 }, goal: { x: 20, y: 0 },
      pairs: [{ a: { x: 0, y: 0 }, b: { x: 20, y: 0 } }], dry: () => null, cost: points => route(points), startHeading: 0, endHeading: 0 }
    expect(routeAcrossBridges(input)!.length).toBe(20)
    expect(routeAcrossBridges({ ...input, startHeading: Math.PI / 2 })).toBeNull()
    expect(routeAcrossBridges({ ...input, pairs: [] })).toBeNull()
  })
  it('only plans land legs on competitive paths through a large survey set', () => {
    let searches = 0
    const pairs = Array.from({ length: 22 }, (_, i) => ({ a: { x: 90, y: i * 100 }, b: { x: 110, y: i * 100 } }))
    const result = routeAcrossBridges({ ...options, start: { x: 0, y: 0 }, goal: { x: 200, y: 0 }, pairs,
      dry: (a, b) => { searches++; return (a.x <= 90) === (b.x <= 90) ? route([a, b]) : null },
      cost: points => route(points, length(points) * 13 + 420),
      lowerBound: (a, b) => Math.hypot(b.x - a.x, b.y - a.y),
    })!
    expect(result.cost).toBe(180 + 20 * 13 + 420)
    expect(result.points.every(p => p.y === 0)).toBe(true)
    // One rejected direct crossing, then both approaches to the best bridge.
    // Surveying 22 crossings must not launch all 44² bank-to-bank searches.
    expect(searches).toBe(3)
  })
})
