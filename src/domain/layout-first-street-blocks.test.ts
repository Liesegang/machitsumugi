import { describe, expect, it } from 'vitest'
import { distanceToSegment, pointInPolygon, polygonArea, rectangle } from './geometry'
import { adoptLayoutInfillZones, layoutStreetFaceCenter, splitLayoutStreetFace } from './layout-first-street-blocks'
import type { LayoutFirstZone } from './layout-first-types'

describe('actual street-face subdivision', () => {
  it('locates enclosed land independently of extra survey vertices along one perimeter road', () => {
    const square = rectangle(0, 0, 400, 400), surveyed = [...square.slice(0, 2), ...Array.from({ length: 39 }, (_, i) => ({ x: 400, y: (i + 1) * 10 })), ...square.slice(2)]
    expect(layoutStreetFaceCenter(surveyed)).toEqual({ x: 200, y: 200 })
    expect(layoutStreetFaceCenter(surveyed)).toEqual(layoutStreetFaceCenter(square))
  })
  it('preserves a skew surveyed perimeter and joins two of its real edges', () => {
    const face = [{ x: 10, y: 0 }, { x: 430, y: 30 }, { x: 390, y: 330 }, { x: 0, y: 290 }]
    const split = splitLayoutStreetFace(face, { spacing: 108, angle: .06, seed: 'surveyed-face' })!
    expect(split).not.toBeNull()
    expect(split.polygons.reduce((sum, child) => sum + polygonArea(child), 0)).toBeCloseTo(polygonArea(face), 6)
    for (const endpoint of split.points) expect(Math.min(...face.map((a, i) => distanceToSegment(endpoint, a, face[(i + 1) % face.length]!)))).toBeLessThan(1e-7)
    for (let n = 1; n < 20; n++) expect(pointInPolygon({ x: split.points[0].x + (split.points[1].x - split.points[0].x) * n / 20, y: split.points[0].y + (split.points[1].y - split.points[0].y) * n / 20 }, face)).toBe(true)
  })

  it('produces compact, different historic and postwar grains from the same perimeter', () => {
    const subdivide = (spacing: number, jitter: number) => {
      const queue = [rectangle(0, 0, 420, 420)], finished: typeof queue = []
      for (let n = 0; n < queue.length; n++) {
        const split = splitLayoutStreetFace(queue[n]!, { spacing, jitter, seed: `grain:${n}` })
        if (split) queue.push(...split.polygons)
        else finished.push(queue[n]!)
      }
      return finished
    }
    const historic = subdivide(70, .30), postwar = subdivide(108, .045)
    expect(historic.length).toBeGreaterThan(postwar.length * 1.8)
    expect(historic.reduce((sum, face) => sum + polygonArea(face), 0)).toBeCloseTo(420 ** 2, 5)
    expect(postwar.length).toBeGreaterThanOrEqual(12)
    expect(postwar.every(face => polygonArea(face) < 17000)).toBe(true)
    expect(splitLayoutStreetFace(rectangle(0, 0, 75, 80), { spacing: 70, seed: 'finished' })).toBeNull()
  })

  it('never joins across the exterior notch of a concave road face', () => {
    const face = [{ x: 0, y: 0 }, { x: 420, y: 0 }, { x: 420, y: 420 }, { x: 270, y: 420 }, { x: 270, y: 140 }, { x: 150, y: 140 }, { x: 150, y: 420 }, { x: 0, y: 420 }]
    const options = { spacing: 70, angle: Math.PI / 2, seed: 'notch', jitter: .1 }
    const split = splitLayoutStreetFace(face, options)!
    expect(split).not.toBeNull()
    expect(splitLayoutStreetFace(face, options)).toEqual(split)
    expect(split.polygons.reduce((sum, child) => sum + polygonArea(child), 0)).toBeCloseTo(polygonArea(face), 6)
    for (let n = 1; n < 40; n++) expect(pointInPolygon({ x: split.points[0].x + (split.points[1].x - split.points[0].x) * n / 40, y: split.points[0].y + (split.points[1].y - split.points[0].y) * n / 40 }, face)).toBe(true)
  })
})

describe('enclosed interior infill briefs', () => {
  const neighbourhood = (id: string, x: number): LayoutFirstZone => ({ id, center: { x, y: 500 }, radius: 250, polygon: rectangle(x - 250, 250, 500, 500), kind: 'residential', builtYear: 1955, density: .85, maximumFloors: 5, angle: 0 })
  const zones = [neighbourhood('west', 500), neighbourhood('east', 1100)]
  const gap = rectangle(760, 420, 80, 160)
  const options = { settlement: 'metropolis' as const, density: .9, corridorSpacing: 350, canBuild: () => true, excludedRegions: [] }

  it('adopts a physically buildable closed gap between urban neighbours without mutating their briefs', () => {
    const original = JSON.stringify(zones), result = adoptLayoutInfillZones([gap], zones, options)
    expect(result).toHaveLength(3)
    expect(result[2]).toMatchObject({ id: 'layout-infill-face-0', kind: 'residential', builtYear: 1955, density: .85, maximumFloors: 5 })
    expect(result[2]!.polygon).toEqual(gap)
    expect(result[2]!.polygon).not.toBe(gap)
    expect(JSON.stringify(zones)).toBe(original)
  })

  it('keeps countryside, rural settlements, reserved/water faces and steep interiors open', () => {
    const fringe = rectangle(1430, 420, 200, 200)
    expect(adoptLayoutInfillZones([fringe], zones, options)).toHaveLength(2)
    expect(adoptLayoutInfillZones([gap], zones, { ...options, settlement: 'rural-town' })).toHaveLength(2)
    expect(adoptLayoutInfillZones([gap], zones, { ...options, excludedRegions: [{ polygon: rectangle(790, 400, 10, 220) }] })).toHaveLength(2)
    expect(adoptLayoutInfillZones([gap], zones, { ...options, canBuild: p => p.x < 790 || p.x > 815 })).toHaveLength(2)
  })
})
