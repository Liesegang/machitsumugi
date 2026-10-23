import { describe, expect, it } from 'vitest'
import { agriculturalPlots, agriculturalPlotSuitable, agriculturalRemnantSuitable, agriculturalUse, contourLand, contourNaturalLand, settlementDensity } from './land-use'
import { boundsOf, clippingDiagnostics, corridorPolygon, intersectRegions, overlaps, pointInRegion, polygonOverlapsRegion, rectangle, regionArea, subtractRegions } from './geometry'
import { templeClippingFixture } from './fixtures/temple-clipping'
import type { Point, Road } from './types'

// Fourfold bearing treats the two perpendicular edges of a rectangular title
// as one survey axis, without mistaking a long boundary cut for its direction.
const surveyAxis = (polygon: Point[]) => {
  let x = 0, y = 0, total = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, length = Math.hypot(b.x - a.x, b.y - a.y), angle = Math.atan2(b.y - a.y, b.x - a.x)
    x += Math.cos(angle * 4) * length; y += Math.sin(angle * 4) * length; total += length
  }
  return { angle: Math.atan2(y, x) / 4, alignment: Math.hypot(x, y) / total }
}
const bearingDifference = (a: number, b: number) => Math.abs(Math.atan2(Math.sin((a - b) * 4), Math.cos((a - b) * 4)) / 4)

describe('land conversion and remaining cover', () => {
  it('preserves the real temple failure boundary and enclosed holes with an independent integer fallback', () => {
    const before = clippingDiagnostics.preciseFallbacks
    const { subject, obstacles } = templeClippingFixture
    const pieces = subtractRegions(subject, obstacles)
    expect(clippingDiagnostics.preciseFallbacks).toBeGreaterThan(before)
    // Independent GEOS/Shapely union+difference of the same centimetre inputs:
    // remaining 158839.9523078649m², not a discarded tile or unchanged subject.
    expect(pieces.reduce((sum, region) => sum + regionArea(region), 0)).toBeCloseTo(158839.9523078649, 2)
    expect(pieces.flatMap(region => region.holes ?? []).length).toBe(2)
    expect(pieces.some(r => pointInRegion({ x: 1971.8341232490563, y: 49.28 }, r))).toBe(false)
    expect(pieces.some(r => pointInRegion({ x: 1938.8740097612554, y: 75.005 }, r))).toBe(false)
    for (const region of pieces) for (const ring of [region.polygon, ...region.holes ?? []]) for (const p of ring) {
      expect(p.x).toBeGreaterThanOrEqual(1600)
      expect(p.x).toBeLessThanOrEqual(2000)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(400)
    }
    // Test the classification against a separate ray-crossing implementation,
    // including tiny islands of unacquired ground between overlapping masks.
    const contains = (ring: { x: number; y: number }[], x: number, y: number) => {
      let count = 0
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!, b = ring[j]!
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) count++
      }
      return count % 2 === 1
    }
    for (let y = 25.37; y < 110; y++) for (let x = 1920.41; x < 1985; x++) {
      const expected = !obstacles.some(o => contains(o.polygon, x, y))
      const actual = pieces.some(r => contains(r.polygon, x, y) && !(r.holes ?? []).some(h => contains(h, x, y)))
      expect(actual).toBe(expected)
    }
  })
  it('allows an island interior but rejects parcels that cross or surround its bank', () => {
    const water = { polygon: rectangle(0, 0, 100, 100), holes: [rectangle(20, 20, 60, 60)] }
    expect(polygonOverlapsRegion(rectangle(30, 30, 20, 20), water)).toBe(false)
    expect(polygonOverlapsRegion(rectangle(10, 30, 20, 20), water)).toBe(true)
    expect(polygonOverlapsRegion(rectangle(10, 10, 80, 80), water)).toBe(true)
    expect(polygonOverlapsRegion(rectangle(110, 30, 20, 20), water)).toBe(false)
    const inlet = { polygon: water.polygon, holes: [[{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 80 }, { x: 20, y: 80 }]] }
    expect(polygonOverlapsRegion([{ x: 30, y: 30 }, { x: 70, y: 30 }, { x: 30, y: 70 }], inlet)).toBe(true)
    expect(subtractRegions({ polygon: rectangle(30, 30, 20, 20) }, [water]).reduce((sum, r) => sum + regionArea(r), 0)).toBeCloseTo(400, 5)
  })
  it('retains the unacquired part of a field and interior garden holes', () => {
    const pieces = subtractRegions({ polygon: rectangle(0, 0, 100, 100) }, [
      { polygon: rectangle(20, 20, 20, 30) },
      { polygon: rectangle(30, 25, 20, 30) },
    ])
    expect(pieces.reduce((sum, region) => sum + regionArea(region), 0)).toBeCloseTo(9050, 5)
    expect(pieces.some(region => pointInRegion({ x: 10, y: 10 }, region))).toBe(true)
    expect(pieces.some(region => pointInRegion({ x: 35, y: 35 }, region))).toBe(false)
    expect(pieces.flatMap(region => region.holes ?? []).length).toBe(1)
  })

  it('preserves bounded land around near-coincident transport acquisitions', () => {
    const subject = { polygon: rectangle(1600, 200, 80, 50) }
    const cuts = Array.from({ length: 8 }, (_, i) => ({ polygon: corridorPolygon({ x: 1610 + i * 7.35, y: 190 + i * 5.1 }, { x: 1650 + i * 2.4, y: 260 - i * 1.7 }, 2.8) }))
    const pieces = subtractRegions(subject, cuts)
    const area = pieces.reduce((sum, region) => sum + regionArea(region), 0)
    expect(area).toBeGreaterThan(0)
    expect(area).toBeLessThan(4000)
    for (const region of pieces) for (const point of region.polygon) {
      expect(point.x).toBeGreaterThanOrEqual(1600 - .02)
      expect(point.x).toBeLessThanOrEqual(1680 + .02)
      expect(point.y).toBeGreaterThanOrEqual(200 - .02)
      expect(point.y).toBeLessThanOrEqual(250 + .02)
    }
  })

  it('traces a continuous sloping boundary without exposing square sampling cells', () => {
    const regions = contourLand(400, 300, p => 375 - p.x - p.y, 20).flatMap(region => intersectRegions(region, { polygon: rectangle(0, 0, 400, 300) }))
    // Triangle x+y<375, truncated by the 300m top edge: 67,500 square metres.
    expect(regions.reduce((sum, r) => sum + regionArea(r), 0)).toBeCloseTo(67_500, -1)
    expect(regions.some(r => pointInRegion({ x: 60, y: 80 }, r))).toBe(true)
    expect(regions.some(r => pointInRegion({ x: 360, y: 260 }, r))).toBe(false)
  })

  it('keeps a hollow contour as a hole instead of filling the inner use', () => {
    const regions = contourLand(400, 400, p => { const r = Math.hypot(p.x - 200, p.y - 200); return Math.min(r - 55, 140 - r) }, 12)
    expect(regions).toHaveLength(1)
    expect(regions[0]!.holes).toHaveLength(1)
    expect(pointInRegion({ x: 200, y: 200 }, regions[0]!)).toBe(false)
    expect(pointInRegion({ x: 290, y: 200 }, regions[0]!)).toBe(true)
  })

  it('reconstructs a curved natural boundary within metres and without coarse angular chords', () => {
    const regions = contourNaturalLand(400, 400, p => 140 ** 2 - (p.x - 200) ** 2 - (p.y - 200) ** 2)
    expect(regions).toHaveLength(1)
    const ring = regions[0]!.polygon
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length]!, b = ring[i]!, c = ring[(i + 1) % ring.length]!
      expect(Math.abs(Math.hypot(b.x - 200, b.y - 200) - 140)).toBeLessThan(1)
      const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y)
      expect(bc).toBeLessThan(6)
      if (ab > .01 && bc > .01) {
        const turn = Math.acos(Math.max(-1, Math.min(1, ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (ab * bc))))
        expect(turn).toBeLessThan(4 * Math.PI / 180)
      }
    }
  })

  it('does not bend a genuinely straight physical suitability boundary', () => {
    const contours = contourNaturalLand(400, 300, p => 375 - p.x - p.y)
    const regions = contours
      .flatMap(region => intersectRegions(region, { polygon: rectangle(0, 0, 400, 300) }))
    expect(regions.reduce((sum, r) => sum + regionArea(r), 0)).toBeCloseTo(67_500, 2)
    const boundary = contours.flatMap(r => r.polygon).filter(p => p.x > 1 && p.x < 399 && p.y > 1 && p.y < 299)
    expect(boundary.length).toBeGreaterThan(20)
    expect(boundary.every(p => Math.abs(p.x + p.y - 375) < .001)).toBe(true)
  })

  it('keeps natural holes, exact crop borders and subsequently acquired rectangular boundaries', () => {
    const natural = contourNaturalLand(400, 400, p => Math.hypot(p.x - 200, p.y - 200) - 55)
      .flatMap(region => intersectRegions(region, { polygon: rectangle(0, 0, 400, 400) }))
    expect(natural).toHaveLength(1)
    expect(natural[0]!.holes).toHaveLength(1)
    expect(pointInRegion({ x: 200, y: 200 }, natural[0]!)).toBe(false)
    expect(pointInRegion({ x: .1, y: .1 }, natural[0]!)).toBe(true)
    const acquired = { polygon: rectangle(25, 25, 35, 70) }
    const remaining = natural.flatMap(region => subtractRegions(region, [acquired]))
    expect(remaining.reduce((sum, r) => sum + regionArea(r), 0)).toBeCloseTo(natural.reduce((sum, r) => sum + regionArea(r), 0) - 2450, 2)
    const rectangularHole = remaining.flatMap(r => r.holes ?? []).find(ring => ring.some(p => p.x === 25 && p.y === 25))
    expect(rectangularHole).toHaveLength(4)
    expect(contourNaturalLand(100, 100, () => -Infinity)).toEqual([])
  })

  it('uses occupied parcel area, leaving undeveloped candidates out of settlement density', () => {
    const parcel = { id: 'lot', polygon: rectangle(80, 80, 40, 40), entrance: { x: 100, y: 80 }, roadId: 'street', createdYear: 1900, use: 'residential' as const }
    expect(settlementDensity([parcel])({ x: 100, y: 100 })).toBe(0)
    const density = settlementDensity([{ ...parcel, developedYear: 1920 }])
    expect(density({ x: 100, y: 100 })).toBeGreaterThan(0)
    expect(density({ x: 500, y: 500 })).toBe(0)
    expect(settlementDensity([{ ...parcel, developedYear: 1920, retiredYear: 1980 }])({ x: 100, y: 100 })).toBe(0)
  })

  it('retains shared agricultural districts with different parcel sizes and reproducible ownership', () => {
    const plots = agriculturalPlots(1000, 800, 'ownership')
    expect(plots).toEqual(agriculturalPlots(1000, 800, 'ownership'))
    expect(plots).not.toEqual(agriculturalPlots(1000, 800, 'other-owner'))
    const inside = plots.filter(p => p.center.x > 0 && p.center.x < 1000 && p.center.y > 0 && p.center.y < 800)
    const sizes = inside.map(p => regionArea(p)).sort((a, b) => a - b)
    expect(sizes[Math.floor(sizes.length * .9)]! / sizes[Math.floor(sizes.length * .1)]!).toBeGreaterThan(1.7)
    // Independent area intersections verify that changing row subdivisions does
    // not create overlapping ownership or double-count the same cultivable land.
    for (let i = 0; i < Math.min(30, inside.length); i++) for (let j = i + 1; j < Math.min(30, inside.length); j++) expect(intersectRegions(inside[i]!, inside[j]!).reduce((sum, r) => sum + regionArea(r), 0)).toBeLessThan(.1)
  })

  it('aligns contiguous survey districts with their inherited farm-road reaches, without modern streets rewriting ownership', () => {
    const roads: Road[] = [
      { id: 'old-valley-road', points: [{ x: 80, y: 210 }, { x: 650, y: 210 }], kind: 'local', width: 3.5, role: 'farm', builtYear: 1650 },
      { id: 'old-tributary-road', points: [{ x: 800, y: 400 }, { x: 1100, y: 700 }], kind: 'local', width: 3.5, role: 'farm', builtYear: 1650 },
    ]
    const flat = { elevation: () => 2, slope: () => 0, wetness: () => .1, channelAt: () => null }
    const plots = agriculturalPlots(1200, 900, 'district-access', [], flat, roads)
    for (const [roadId, expected] of [['old-valley-road', 0], ['old-tributary-road', Math.PI / 4]] as const) {
      const axes = plots.filter(p => p.sourceRoadId === roadId).map(p => surveyAxis(p.polygon)).filter(a => a.alignment > .99)
      expect(axes.length).toBeGreaterThan(15)
      expect(axes.every(a => bearingDifference(a.angle, expected) < 1e-7)).toBe(true)
    }
    expect(plots).toEqual(agriculturalPlots(1200, 900, 'district-access', [], flat, [...roads, { id: 'new-estate', points: [{ x: 100, y: 650 }, { x: 1100, y: 500 }], kind: 'local', width: 8, builtYear: 1970 }]))
    // Different orientation districts have one shared cadastral allocation;
    // they never double-own the land where their rectangular lattices meet.
    const bounds = plots.map(p => boundsOf(p.polygon))
    for (let i = 0; i < plots.length; i++) for (let j = i + 1; j < plots.length; j++) {
      if (plots[i]!.districtId === plots[j]!.districtId) continue
      if (!overlaps(bounds[i]!, bounds[j]!)) continue
      const intersections = intersectRegions(plots[i]!, plots[j]!)
      expect(intersections.reduce((sum, r) => sum + regionArea(r), 0)).toBeLessThan(.01)
    }
  })

  it('uses nearby tributary tangents rather than the end-to-end bearing of one main river', () => {
    const terrain = { elevation: () => 2, slope: () => 0, wetness: () => .5, channelAt: (p: Point) => ({ bankDistance: 100, surfaceElevation: 1, tangent: p.x < 600 ? { x: 1, y: 0 } : { x: 1, y: 1 }, riverId: p.x < 600 ? 'main' : 'tributary' }) }
    // Deliberately vertical main-river endpoints must not override local
    // east-west and northeast tributary data supplied by the terrain model.
    const plots = agriculturalPlots(1200, 900, 'tributary-survey', [{ x: 20, y: 0 }, { x: 20, y: 900 }], terrain)
    for (const [minX, maxX, expected] of [[0, 300, 0], [900, 1200, Math.PI / 4]]) {
      const axes = plots.filter(p => p.center.x > minX! && p.center.x < maxX! && p.center.y > 0 && p.center.y < 900).map(p => surveyAxis(p.polygon)).filter(a => a.alignment > 1 - 1e-10)
      expect(axes.length).toBeGreaterThan(8)
      expect(axes.every(a => bearingDifference(a.angle, expected!) < 1e-7)).toBe(true)
    }
  })

  it('requires flat land and an attainable water supply for rice fields rather than wetness alone', () => {
    const plot = rectangle(100, 100, 35, 75)
    const irrigable = {
      elevation: (p: Point) => Math.max(2, 2 + (100 - p.y) * .01), slope: () => .004, wetness: () => .5,
      channelAt: () => ({ bankDistance: 180, surfaceElevation: 1 }),
      rivers: [{ id: 'river', points: [{ x: -80, y: -900 }, { x: -80, y: 200 }, { x: -80, y: 600 }], surfaceElevation: [12, 1, .5] }],
    }
    expect(agriculturalUse(plot, irrigable)).toBe('paddy')
    expect(agriculturalUse(plot, { ...irrigable, channelAt: () => null })).toBe('dry-field')
    expect(agriculturalUse(plot, { ...irrigable, channelAt: () => ({ bankDistance: 1200, surfaceElevation: 1 }) })).toBe('dry-field')
    expect(agriculturalUse(plot, { ...irrigable, elevation: () => 25 })).toBe('dry-field')
    expect(agriculturalUse(plot, { ...irrigable, slope: () => .05 })).toBe('dry-field')
    expect(agriculturalUse(plot, { ...irrigable, elevation: p => p.y / 20 })).toBe('dry-field')
    expect(agriculturalUse(plot, { ...irrigable, wetness: () => .1 })).toBe('dry-field')
    // The old test treated a river 8m below a field as an irrigation supply.
    // Without a higher upstream intake, or with a ridge blocking the canal,
    // gravity cannot deliver water regardless of wet soil or map proximity.
    expect(agriculturalUse(plot, { ...irrigable, rivers: irrigable.rivers.map(r => ({ ...r, surfaceElevation: [1, 1, 1] })) })).toBe('dry-field')
    expect(agriculturalUse(plot, { ...irrigable, elevation: p => p.x < 90 ? 30 : 2 })).toBe('dry-field')
    expect(agriculturalUse(plot, { ...irrigable, rivers: [] })).toBe('dry-field')
  })

  it('keeps workable acquired farm remnants and intact urban holdings, not narrow scraps between houses', () => {
    const full = { polygon: rectangle(0, 0, 40, 60) }
    expect(agriculturalRemnantSuitable(full, 2400, .4)).toBe(true)
    expect(agriculturalRemnantSuitable({ polygon: rectangle(0, 0, 30, 60) }, 2400, .4)).toBe(true)
    expect(agriculturalRemnantSuitable({ polygon: rectangle(0, 0, 20, 60) }, 2400, .4)).toBe(false)
    expect(agriculturalRemnantSuitable({ polygon: rectangle(0, 0, 20, 60) }, 2400, .1)).toBe(true)
    expect(agriculturalRemnantSuitable({ polygon: rectangle(0, 0, 6, 80) }, 2400, .1)).toBe(false)
    expect(agriculturalRemnantSuitable({ polygon: rectangle(0, 0, 10, 15) }, 2400, 0)).toBe(false)
    // Courtyards acquired inside a title reduce productive area and increase
    // the working perimeter, even if its external bounding box stays large.
    expect(agriculturalRemnantSuitable({ ...full, holes: [rectangle(3, 3, 34, 54)] }, 2400, 0)).toBe(false)
  })

  it('rejects the whole surveyed farm unit at natural limits rather than carving curved remnants', () => {
    const plot = rectangle(100, 100, 80, 60), original = structuredClone(plot)
    const curvedLimit = contourNaturalLand(400, 400, p => 45 ** 2 - (p.x - 200) ** 2 - (p.y - 130) ** 2)
    expect(agriculturalPlotSuitable(plot, () => true, curvedLimit)).toBe(false)
    // Even a steep interior pocket, with all four corners suitable, invalidates
    // the survey unit. Existing field boundaries are never replaced by an isoline.
    expect(agriculturalPlotSuitable(plot, p => Math.hypot(p.x - 140, p.y - 130) > 16)).toBe(false)
    expect(agriculturalPlotSuitable(plot, () => true)).toBe(true)
    expect(plot).toEqual(original)
    const waterWithIsland = { polygon: rectangle(0, 0, 400, 400), holes: [rectangle(80, 80, 130, 100)] }
    expect(agriculturalPlotSuitable(plot, () => true, [waterWithIsland])).toBe(true)
  })

  it('puts the short rice-field dimension across the local slope and retains separate earthen banks', () => {
    const terrain = (axis: 'x' | 'y') => ({
      elevation: (p: Point) => p[axis] * .005, slope: () => .005, wetness: () => .5,
      channelAt: (p: Point) => ({ bankDistance: 100, surfaceElevation: p[axis] * .005 - 1 }),
      rivers: [{ id: 'upstream-supply', points: axis === 'x' ? [{ x: 1800, y: -100 }, { x: 0, y: -100 }] : [{ x: -100, y: 1800 }, { x: -100, y: 0 }], surfaceElevation: [8, -1] }],
    })
    const plots = (axis: 'x' | 'y') => agriculturalPlots(1000, 800, 'irrigation', [], terrain(axis)).filter(p => p.center.x > 0 && p.center.x < 1000 && p.center.y > 0 && p.center.y < 800 && p.landUse === 'paddy')
    const ratio = (axis: 'x' | 'y') => {
      const dimensions = plots(axis).map(p => {
        const xs = p.polygon.map(q => q.x), ys = p.polygon.map(q => q.y)
        return (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys))
      }).sort((a, b) => a - b)
      expect(dimensions.length).toBeGreaterThan(30)
      return dimensions[Math.floor(dimensions.length / 2)]!
    }
    expect(ratio('x')).toBeLessThan(.8)
    expect(ratio('y')).toBeGreaterThan(1.4)
    const rice = plots('x')
    // Ownership polygons leave ground between rice cells; they are not a
    // decorative line overlay which still represents one undivided field.
    for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++) expect(intersectRegions(rice[i]!, rice[j]!).reduce((sum, r) => sum + regionArea(r), 0)).toBe(0)
  })
})
