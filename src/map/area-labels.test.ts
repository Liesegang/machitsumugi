import { describe, expect, it } from 'vitest'
import { areaLabelPoint, interiorLabelPoint } from './area-labels'
import { distanceToSegment, pointInRegion, rectangle } from '../domain/geometry'
import type { Area } from '../domain/types'

describe('area labels remain in the actual named region', () => {
  it('places a concave bay label on water when its vertex average lies on the peninsula', () => {
    const bay = { polygon: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 220, y: 300 }, { x: 220, y: 80 }, { x: 80, y: 80 }, { x: 80, y: 300 }, { x: 0, y: 300 }] }
    expect(pointInRegion({ x: 150, y: 170 }, bay)).toBe(false)
    const point = interiorLabelPoint(bay)!
    expect(pointInRegion(point, bay)).toBe(true)
    expect(Math.min(...bay.polygon.map((p, i) => distanceToSegment(point, p, bay.polygon[(i + 1) % bay.polygon.length]!)))).toBeGreaterThan(30)
    expect(interiorLabelPoint(bay)).toBe(point)
  })
  it('avoids an island and invalidates the cached anchor when holes change', () => {
    const sea = { polygon: rectangle(0, 0, 400, 400), holes: [rectangle(100, 100, 200, 200)] }
    expect(pointInRegion({ x: 200, y: 200 }, sea)).toBe(false)
    const first = interiorLabelPoint(sea)!
    expect(pointInRegion(first, sea)).toBe(true)
    sea.holes = [rectangle(0, 0, 350, 400)]
    const next = interiorLabelPoint(sea)!
    expect(pointInRegion(next, sea)).toBe(true)
    expect(next.x).toBeGreaterThan(350)
    expect(next).not.toBe(first)
  })
  it('finds narrow water through scanline intervals and omits degenerate regions', () => {
    const river = { polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1001, y: 1000 }, { x: 1000, y: 1000 }] }
    expect(pointInRegion(interiorLabelPoint(river)!, river)).toBe(true)
    expect(interiorLabelPoint({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }] })).toBeNull()
  })
  it('places a river name on visible flowing water instead of its channel beneath the sea', () => {
    const river: Area = { id: 'river', kind: 'water', polygon: rectangle(0, 100, 400, 20) }
    const sea: Area = { id: 'sea', kind: 'water', waterLevel: 0, polygon: rectangle(100, 0, 300, 400) }
    const point = areaLabelPoint(river, [river, sea])!
    expect(pointInRegion(point, river)).toBe(true)
    expect(pointInRegion(point, sea)).toBe(false)
    expect(point.x).toBeLessThan(100)
    expect(areaLabelPoint(river, [river, { ...sea, polygon: rectangle(-10, 0, 420, 400) }])).toBeNull()
  })
})
