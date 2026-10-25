import { describe, expect, it } from 'vitest'
import type { Point } from './types'
import type { LayoutFirstZone } from './layout-first-types'
import { distanceToSegment, pointInPolygon, polygonArea, rectangle } from './geometry'
import { planLayoutStreetFabricSplit } from './layout-first-street-fabric'
import { splitLayoutStreetFacePath } from './layout-first-street-blocks'

const zone = (kind: LayoutFirstZone['kind'] = 'residential'): LayoutFirstZone => ({ id: 'neighbourhood', center: { x: 210, y: 210 }, radius: 900, polygon: rectangle(-600, -600, 1800, 1800), kind, builtYear: kind === 'historic' ? 1650 : 1900, density: .9, maximumFloors: 5, angle: 1.2 })
const borderDistance = (point: Point, polygon: Point[]) => Math.min(...polygon.map((a, i) => distanceToSegment(point, a, polygon[(i + 1) % polygon.length]!)))

describe('local street fabric proposals', () => {
  it('takes its direction from actual perimeter roads rather than the whole-city zone angle', () => {
    const angle = .37, rotate = (p: Point) => ({ x: p.x * Math.cos(angle) - p.y * Math.sin(angle), y: p.x * Math.sin(angle) + p.y * Math.cos(angle) })
    const polygon = rectangle(0, 0, 520, 360).map(rotate)
    const input = { polygon, zone: zone(), seed: 'actual-frontage', depth: 0, frontages: [{ a: polygon[0]!, b: polygon[1]!, roadId: 'old-road', width: 9, builtYear: 1650 }] }
    const first = planLayoutStreetFabricSplit(input)!
    expect(first).not.toBeNull()
    expect(Math.abs(Math.sin(2 * (first.bearing - angle)))).toBeLessThan(1e-8)
    expect(planLayoutStreetFabricSplit({ ...input, zone: { ...input.zone, angle: -.9 } })).toEqual(first)
  })

  it('uses offset T junctions on a shared old road, without independently jittering street vertices', () => {
    const upper = rectangle(0, 0, 420, 300), lower = rectangle(0, 300, 420, 300), frontages = [{ a: { x: 0, y: 300 }, b: { x: 420, y: 300 }, roadId: 'shared-road', width: 9, builtYear: 1650 }]
    const trials = Array.from({ length: 8 }, (_, index) => {
      const a = planLayoutStreetFabricSplit({ polygon: upper, zone: zone(), seed: `offset-junction:${index}`, depth: 0, frontages })!
      const b = planLayoutStreetFabricSplit({ polygon: lower, zone: zone(), seed: `offset-junction:${index}`, depth: 0, frontages })!
      const first = a.points.find(p => Math.abs(p.y - 300) < 1e-7)!, second = b.points.find(p => Math.abs(p.y - 300) < 1e-7)!
      expect(a.points).toHaveLength(2); expect(b.points).toHaveLength(2)
      expect(Math.abs(polygonArea(a.polygons[0]!) / polygonArea(upper) - .5)).toBeGreaterThan(.05)
      return Math.abs(first.x - second.x)
    })
    expect(trials.filter(offset => offset > 20).length).toBeGreaterThanOrEqual(4)
  })

  it('confines readjusted rectangular blocks to a bounded flat postwar patch', () => {
    const neighbourhood = { ...zone(), builtYear: 1975 }
    const polygon = rectangle(0, 0, 420, 420), terrain = { slope: () => 0, elevation: () => 12 }
    const seed = Array.from({ length: 20 }, (_, n) => `patch-${n}`).find(seed => planLayoutStreetFabricSplit({ polygon, zone: neighbourhood, seed, depth: 0, terrain })?.kind === 'readjusted')!
    expect(seed).toBeDefined()
    expect(planLayoutStreetFabricSplit({ polygon, zone: neighbourhood, seed, depth: 0, terrain })?.width).toBe(6.5)
    expect(planLayoutStreetFabricSplit({ polygon: rectangle(650, 0, 420, 420), zone: neighbourhood, seed, depth: 0, terrain })?.kind).toBe('incremental')
    expect(planLayoutStreetFabricSplit({ polygon, zone: neighbourhood, seed, depth: 0, terrain: { ...terrain, slope: () => .055 } })?.kind).toBe('incremental')
  })

  it('can propose a deliberate old-town dogleg while preserving the exact two child faces', () => {
    const polygon = rectangle(0, 0, 500, 420), input = { polygon, zone: zone('historic'), depth: 0 }
    const proposal = Array.from({ length: 20 }, (_, n) => planLayoutStreetFabricSplit({ ...input, seed: `old-road-${n}` })).find(result => result?.points.length === 3)!
    expect(proposal).toBeDefined()
    expect(proposal.kind).toBe('historic')
    expect(proposal.width).toBe(4.8)
    expect(proposal.polygons.reduce((sum, child) => sum + polygonArea(child), 0)).toBeCloseTo(polygonArea(polygon), 6)
    expect(borderDistance(proposal.points[0]!, polygon)).toBeLessThan(1e-6)
    expect(borderDistance(proposal.points.at(-1)!, polygon)).toBeLessThan(1e-6)
    expect(pointInPolygon(proposal.points[1]!, polygon)).toBe(true)
  })

  it('is deterministic and leaves the supplied physical face and brief unchanged', () => {
    const input = { polygon: rectangle(0, 0, 420, 420), zone: zone('historic'), seed: 'immutable', depth: 0 }, before = JSON.stringify(input)
    expect(planLayoutStreetFabricSplit(input)).toEqual(planLayoutStreetFabricSplit(input))
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('polyline division of an existing physical face', () => {
  it('keeps all land in the two children of a bent boundary-to-boundary street', () => {
    const polygon = rectangle(0, 0, 420, 420), path = [{ x: 0, y: 160 }, { x: 170, y: 210 }, { x: 420, y: 260 }]
    const children = splitLayoutStreetFacePath(polygon, path)!
    expect(children).toHaveLength(2)
    expect(children.reduce((sum, child) => sum + polygonArea(child), 0)).toBeCloseTo(420 ** 2, 6)
    expect(children.every(child => child.some(p => p.x === 170 && p.y === 210))).toBe(true)
  })

  it('rejects an exterior notch crossing or a path whose endpoint has no real perimeter junction', () => {
    const polygon = [{ x: 0, y: 0 }, { x: 420, y: 0 }, { x: 420, y: 420 }, { x: 270, y: 420 }, { x: 270, y: 140 }, { x: 150, y: 140 }, { x: 150, y: 420 }, { x: 0, y: 420 }]
    expect(splitLayoutStreetFacePath(polygon, [{ x: 0, y: 250 }, { x: 420, y: 250 }])).toBeNull()
    expect(splitLayoutStreetFacePath(rectangle(0, 0, 420, 420), [{ x: 0, y: 200 }, { x: 200, y: 200 }])).toBeNull()
  })
})
