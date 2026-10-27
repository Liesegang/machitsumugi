import { describe, expect, it } from 'vitest'
import { continuousRoadEndcapsClear } from './continuous-road-endcaps'
import { rectangle } from './geometry'
import type { Point } from './types'

const road: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }]

describe('continuous road outward end caps', () => {
  it('rejects water beyond a dry centreline and side samples at either endpoint', () => {
    expect(continuousRoadEndcapsClear([{ polygon: rectangle(11, -1, 1, 2) }])(road, 6)).toBe(false)
    expect(continuousRoadEndcapsClear([{ polygon: rectangle(-2, -1, 1, 2) }])(road, 6)).toBe(false)
    expect(continuousRoadEndcapsClear([{ polygon: rectangle(4, -1, 1, 2) }])(road, 6)).toBe(true)
  })

  it('leaves the inward bridge-deck half to the surveyed bridge validator', () => {
    const shortBridge = [{ x: 0, y: 0 }, { x: 4, y: 0 }]
    expect(continuousRoadEndcapsClear([{ polygon: rectangle(.25, -2, 3.5, 4) }])(shortBridge, 6)).toBe(true)
  })

  it('permits edge and point contacts but keeps a real sub-centimetre overlap', () => {
    expect(continuousRoadEndcapsClear([{ polygon: rectangle(13, -1, 1, 2) }])(road, 6)).toBe(true)
    expect(continuousRoadEndcapsClear([{ polygon: rectangle(13, 3, 1, 2) }])(road, 6)).toBe(true)
    expect(continuousRoadEndcapsClear([{ polygon: rectangle(12.99999999, -1, 1, 2) }])(road, 6)).toBe(false)
  })

  it('follows rotated tangents and ignores repeated endpoint coordinates', () => {
    const rotation = .713, offset = { x: 1706.98553, y: 1931.28732 }
    const transform = (point: Point): Point => ({ x: offset.x + Math.cos(rotation) * point.x - Math.sin(rotation) * point.y, y: offset.y + Math.sin(rotation) * point.x + Math.cos(rotation) * point.y })
    const points = [road[0]!, road[0]!, road[1]!, road[1]!].map(transform)
    const query = continuousRoadEndcapsClear([{ polygon: rectangle(11, -1, 1, 2).map(transform) }])
    expect(query(points, 6)).toBe(false)
    expect(query([...points].reverse(), 6)).toBe(false)
  })

  it('preserves dry islands and rejects a cap crossing their bank', () => {
    const water = [{ polygon: rectangle(-100, -100, 200, 200), holes: [rectangle(-4, -4, 18, 8)] }]
    const query = continuousRoadEndcapsClear(water)
    expect(query(road, 6)).toBe(true)
    expect(query(road, 10)).toBe(false)
  })

  it('does not mutate input geometry and rejects undefined cap directions', () => {
    const water = [{ polygon: rectangle(11, -1, 1, 2) }], snapshot = JSON.stringify({ water, road })
    const query = continuousRoadEndcapsClear(water)
    query(road, 6)
    expect(JSON.stringify({ water, road })).toBe(snapshot)
    expect(query([{ x: 10, y: 0 }, { x: 10, y: 0 }], 6)).toBe(false)
    expect(query([], 6)).toBe(false)
    expect(query(road, 0)).toBe(false)
    expect(query(road, Infinity)).toBe(false)
  })
})
