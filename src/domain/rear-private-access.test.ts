import { describe, expect, it } from 'vitest'
import type { Point } from './types'
import { corridorPolygon, distanceToSegment, intersectRegions, rectangle, regionArea, subtractRegions } from './geometry'
import { rearPrivateAccess } from './rear-private-access'

const intersection = (path: Point[], building: Point[]) => path.slice(1).reduce((sum, b, i) => sum + intersectRegions({ polygon: corridorPolygon(path[i]!, b, 1.4) }, { polygon: building }).reduce((n, region) => n + regionArea(region), 0), 0)

describe('rear private approach full-width clearance', () => {
  it('keeps a narrow rear-home approach off its facade instead of checking only the centreline', () => {
    const source = { x: 7.1, y: 0 }, bend = { x: 7.1, y: 40 }, terminal = { x: 4.97, y: 40 }, building = rectangle(-5.68, 41, 11.36, 13)
    const original = structuredClone({ source, bend, terminal, building }), oldPath = [source, bend, terminal]
    expect(intersection(oldPath, building)).toBeGreaterThan(.1)
    const path = rearPrivateAccess(source, bend, terminal, building)
    expect(intersection(path, building)).toBe(0)
    expect(path[0]).toEqual(source)
    expect(path[1]!.x).toBe(bend.x)
    expect(path[2]!.x).toBe(terminal.x)
    expect(path[1]!.y).toBeLessThan(bend.y)
    expect(path[1]!.y).toBeGreaterThan(bend.y - 1)
    expect(path[2]!.y).toBe(path[1]!.y)
    expect({ source, bend, terminal, building }).toEqual(original)
  })
  it('surveys the rounded tilted facade and both complete pavement sections', () => {
    const angle = .31, transform = (p: Point) => ({ x: Math.round((400 + p.x * Math.cos(angle) - p.y * Math.sin(angle)) * 10) / 10, y: Math.round((300 + p.x * Math.sin(angle) + p.y * Math.cos(angle)) * 10) / 10 })
    const source = transform({ x: 7.1, y: 0 }), bend = transform({ x: 7.1, y: 40 }), terminal = transform({ x: 4.97, y: 40 }), building = rectangle(-5.68, 41, 11.36, 13).map(transform)
    expect(intersection([source, bend, terminal], building)).toBeGreaterThan(.1)
    const path = rearPrivateAccess(source, bend, terminal, building)
    expect(intersection(path, building)).toBe(0)
    for (let i = 1; i < path.length; i++) expect(intersectRegions({ polygon: corridorPolygon(path[i - 1]!, path[i]!, 1.45) }, { polygon: building }).reduce((sum, r) => sum + regionArea(r), 0)).toBe(0)
  })
  it('repairs the actual tilted rear holding without expanding its title or original paved access', () => {
    const source = { x: 1707.9, y: 1602.9 }, bend = { x: 1750.8, y: 1619.2 }, terminal = { x: 1751.6, y: 1617.1 }
    const title = [{ x: 1714.4, y: 1603.8 }, { x: 1713.4, y: 1606.4 }, { x: 1772.6, y: 1629 }, { x: 1778.8, y: 1612.6 }, { x: 1754.7, y: 1603.4 }, { x: 1749.4, y: 1617.2 }]
    const building = [{ x: 1756.4, y: 1607.2 }, { x: 1752.2, y: 1618.2 }, { x: 1765.3, y: 1623.2 }, { x: 1769.5, y: 1612.2 }]
    expect(intersection([source, bend, terminal], building)).toBeGreaterThan(.9)
    const path = rearPrivateAccess(source, bend, terminal, building, title)
    expect(intersection(path, building)).toBe(0)
    // The original0.1m-rounded stem is a few centimetres narrower
    // than its recorded2.8m paving. The repair may reuse that actual access,
    // but must not extend either the holding or its original paved corridor.
    const existingGround = [{ polygon: title }, { polygon: corridorPolygon(source, bend, 1.4) }, { polygon: corridorPolygon(bend, terminal, 1.4) }]
    for (let i = 1; i < path.length; i++) expect(subtractRegions({ polygon: corridorPolygon(path[i - 1]!, path[i]!, 1.4) }, existingGround).reduce((sum, region) => sum + regionArea(region), 0)).toBe(0)
    const outside = subtractRegions({ polygon: corridorPolygon(path[1]!, path[2]!, 1.4) }, [{ polygon: title }])
    const residual = Math.max(0, ...outside.flatMap(region => region.polygon).map(p => Math.min(...title.map((a, i) => distanceToSegment(p, a, title[(i + 1) % title.length]!)))))
    expect(residual).toBeLessThanOrEqual(.075)
  })
  it('stops the existing side passage when a full-width transverse turn would require extra land', () => {
    const source = { x: 2386.2, y: 2229.1 }, bend = { x: 2417.5, y: 2222.9 }, terminal = { x: 2417.1, y: 2220.6 }
    const title = [{ x: 2390.7, y: 2226.8 }, { x: 2391.3, y: 2229.5 }, { x: 2442.3, y: 2219.4 }, { x: 2438.8, y: 2201.8 }, { x: 2412.4, y: 2207.1 }, { x: 2415.3, y: 2221.9 }]
    const building = [{ x: 2415.9, y: 2209.4 }, { x: 2418.2, y: 2221.1 }, { x: 2431, y: 2218.6 }, { x: 2428.6, y: 2206.8 }]
    const path = rearPrivateAccess(source, bend, terminal, building, title)
    expect(path).toHaveLength(2)
    expect(path[0]).toEqual(source)
    expect(intersection(path, building)).toBe(0)
    expect(subtractRegions({ polygon: corridorPolygon(path[0]!, path[1]!, 1.4) }, [{ polygon: corridorPolygon(source, bend, 1.4) }]).reduce((sum, region) => sum + regionArea(region), 0)).toBe(0)
    const doorstep = Math.min(...building.map((a, i) => distanceToSegment(path[1]!, a, building[(i + 1) % building.length]!)))
    expect(doorstep).toBeGreaterThan(1.45)
    expect(doorstep).toBeLessThan(3)
  })
})
