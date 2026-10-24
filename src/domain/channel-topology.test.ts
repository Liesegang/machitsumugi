import { describe, expect, it } from 'vitest'
import { channelHasCrossings, preventChannelCrossings } from './channel-topology'
import type { Point } from './types'

// Independent, unbucketed segment survey for these deliberately small cases.
function crossings(points: Point[]) {
  let count = 0
  for (let i = 1; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
    const a = points[i - 1]!, b = points[i]!, c = points[j - 1]!, d = points[j]!
    const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y, denominator = dx * ey - dy * ex
    if (Math.abs(denominator) < 1e-12) continue
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denominator
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denominator
    if (t > 1e-8 && t < 1 - 1e-8 && u > 1e-8 && u < 1 - 1e-8) count++
  }
  return count
}
const line = (pairs: number[][]): Point[] => pairs.map(([x, y]) => ({ x: x!, y: y! }))

describe('planar channel migration and reconstruction', () => {
  it('resists the crossing reach while preserving unrelated migration and exact pins', () => {
    const previous = line([[0, 0], [20, 0], [40, 0], [40, 40], [0, 40], [-20, 40], [-60, 40], [-100, 40]])
    const proposed = line([[0, 0], [30, 50], [40, -5], [40, 40], [0, 40], [-20, 40], [-60, 45], [-100, 40]])
    expect(crossings(previous)).toBe(0)
    expect(crossings(proposed)).toBeGreaterThan(0)
    const result = preventChannelCrossings(previous, proposed, new Set([0, 7]))
    expect(crossings(result)).toBe(0)
    expect(result).toHaveLength(previous.length)
    expect(result[0]).toEqual(previous[0])
    expect(result[7]).toEqual(previous[7])
    expect(result[6]).toEqual(proposed[6])
  })
  it('rejects a real v12 resampling fold without deleting or reordering hydraulic samples', () => {
    // Eleven consecutive samples from the first rejected proposal in the saved
    // fdhrdjd5 v12 world (main channel indices55..65, metres relative to55).
    // The old arc redistribution jumped past an open hairpin and crossed it.
    const previous = line([[0,0],[-21.0651174,.00039324],[-42.13023479,.00115867],[-62.63750103,4.12866253],[-82.94610319,9.72328918],[-103.20309248,15.5008422],[-122.75669434,11.88351068],[-142.63201557,5.01019357],[-163.00441977,4.7982669],[-181.45742208,12.04488014],[-175.32227581,12.17502404]])
    const proposed = line([[-88.12140686,13.50063075],[-109.47809373,20.73745383],[-123.81498616,13.06243832],[-137.86509953,8.73796024],[-156.19996777,6.18473025],[-168.2430686,15.88429732],[-122.75669434,11.88351068],[-142.63201557,5.01019357],[-209.87567001,12.04159467],[-227.66489963,13.19229286],[-245.35782777,8.09348287]])
    expect(crossings(previous)).toBe(0)
    expect(crossings(proposed)).toBeGreaterThan(0)
    expect(channelHasCrossings(proposed)).toBe(true)
    const result = preventChannelCrossings(previous, proposed, new Set())
    expect(crossings(result)).toBe(0)
    expect(result).toHaveLength(previous.length)
  })
  it('retains an open meander and adjacent shared vertices rather than treating nearby banks as a crossing', () => {
    const points = line([[0, 0], [100, 0], [120, 40], [100, 80], [0, 80]])
    expect(channelHasCrossings(points)).toBe(false)
    expect(preventChannelCrossings(points, points, new Set([0, 4]))).toBe(points)
  })
})
