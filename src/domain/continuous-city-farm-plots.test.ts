import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { subdivideContinuousFarmDistrict } from './continuous-city-farm-plots'
import type { ContinuousFarmDistrictInput } from './continuous-city-farm-plots'
import { boundsOf, intersectRegions, pointInRegion, polygonOverlapsRegion, rectangle, regionArea, subtractRegions } from './geometry'

const fixture = (): ContinuousFarmDistrictInput => ({ regions: [{ polygon: rectangle(104, 100, 400, 300) }], road: { id: 'actual-farm-road', kind: 'local', role: 'farm', width: 8, builtYear: 1970, points: [{ x: 100, y: 50 }, { x: 100, y: 450 }] }, origin: { x: 100, y: 250 }, seed: 'actual-farm-district', terrain: { elevation: () => 20, slope: () => 0, wetness: () => 0, channelAt: () => null, cultivable: () => true, waterAt: () => false } })
const sum = (regions: readonly { polygon: { x: number; y: number }[]; holes?: { x: number; y: number }[][] }[]) => regions.reduce((n, r) => n + regionArea(r), 0)

describe('real road-served agricultural holdings', () => {
  it('divides a400×300m field into unequal whole holdings and actual connected grassed access without losing land', () => {
    const input = fixture(), before = JSON.stringify(input.regions), result = subdivideContinuousFarmDistrict(input)
    expect(result.plots.length).toBeGreaterThan(25)
    expect(sum(result.plots) / 120000).toBeGreaterThan(.88)
    expect(sum(result.bunds)).toBeGreaterThan(3000)
    expect(sum(result.plots) + sum(result.bunds)).toBeCloseTo(120000, 2)
    expect(Math.abs(result.diagnostics.areaError)).toBeLessThan(.01)
    expect(new Set(result.plots.map(p => Math.round(regionArea(p)))).size).toBeGreaterThan(12)
    for (const plot of result.plots) { expect(plot.polygon).toHaveLength(4); expect(sum(subtractRegions(plot, [...input.regions]))).toBeLessThan(.001); expect(plot.landUse).toBe('dry-field') }
    for (const plot of result.plots) for (const bund of result.bunds) expect(sum(intersectRegions(plot, bund))).toBeLessThan(.001)
    expect(JSON.stringify(input.regions)).toBe(before)
    expect(subdivideContinuousFarmDistrict(input)).toEqual(result)
  })
  it('transfers certified access across a positive shared seam but never through a corner to a disconnected field', () => {
    const input = fixture(); input.regions = [{ polygon: rectangle(104, 100, 200, 300) }, { polygon: rectangle(304, 100, 200, 300) }, { polygon: rectangle(504, 400, 80, 80) }]
    const result = subdivideContinuousFarmDistrict(input)
    expect(result.diagnostics.servedParts).toBe(2)
    expect(result.plots.some(plot => { const b = boundsOf(plot.polygon); return b.minX < 304 && b.maxX > 304 })).toBe(true)
    expect(result.plots.some(plot => polygonOverlapsRegion(plot.polygon, input.regions[2]!))).toBe(false)
    expect(sum(result.plots) + sum(result.bunds)).toBeCloseTo(sum(input.regions), 2)
  })
  it('rejects whole units at a real wet hollow and keeps its exact hole instead of trimming plots into arcs', () => {
    const input = fixture(), water = { polygon: rectangle(240, 200, 42, 37) }
    input.regions[0]!.holes = [water.polygon]; input.terrain.waterAt = p => p.x >= 240 && p.x <= 282 && p.y >= 200 && p.y <= 237
    const result = subdivideContinuousFarmDistrict(input)
    expect(result.plots.length).toBeGreaterThan(15)
    for (const plot of result.plots) { expect(plot.polygon).toHaveLength(4); expect(polygonOverlapsRegion(plot.polygon, water)).toBe(false) }
    for (const bund of result.bunds) expect(sum(intersectRegions(bund, water))).toBeLessThan(.001)
    expect(sum(result.plots) + sum(result.bunds)).toBeCloseTo(sum(input.regions), 2)
  })
  it('uses each actual access bearing and never grants access from a controlled road or an unrelated street', () => {
    const input = fixture(), result = subdivideContinuousFarmDistrict(input), angle = .62, rotate = (p: { x: number; y: number }) => ({ x: 700 + p.x * Math.cos(angle) - p.y * Math.sin(angle), y: 500 + p.x * Math.sin(angle) + p.y * Math.cos(angle) })
    const rotated = subdivideContinuousFarmDistrict({ ...input, regions: input.regions.map(region => ({ polygon: region.polygon.map(rotate) })), road: { ...input.road, points: input.road.points.map(rotate) }, origin: rotate(input.origin) })
    expect(rotated.diagnostics.bearing - result.diagnostics.bearing).toBeCloseTo(angle)
    expect(rotated.plots.length).toBeGreaterThan(25)
    expect(subdivideContinuousFarmDistrict({ ...input, road: { ...input.road, controlledAccess: true } }).plots).toEqual([])
    expect(subdivideContinuousFarmDistrict({ ...input, regions: [{ polygon: rectangle(1000, 1000, 400, 300) }] }).plots).toEqual([])
  })
  it('requires tractor-width working access through a neck instead of treating topological connection as a farm lane', () => {
    const input = fixture(), region = (half: number) => ({ polygon: [
      { x: 104, y: 100 }, { x: 204, y: 100 }, { x: 204, y: 250 - half }, { x: 404, y: 250 - half }, { x: 404, y: 100 }, { x: 704, y: 100 },
      { x: 704, y: 400 }, { x: 404, y: 400 }, { x: 404, y: 250 + half }, { x: 204, y: 250 + half }, { x: 204, y: 400 }, { x: 104, y: 400 },
    ] }), narrow = region(.6), wide = region(1.6), before = JSON.stringify([narrow, wide])
    const rejected = subdivideContinuousFarmDistrict({ ...input, regions: [narrow] }), connected = subdivideContinuousFarmDistrict({ ...input, regions: [wide] })
    expect(rejected.plots.length).toBeGreaterThan(0)
    expect(rejected.plots.some(plot => boundsOf(plot.polygon).minX > 400)).toBe(false)
    expect(connected.plots.some(plot => boundsOf(plot.polygon).minX > 400)).toBe(true)
    expect(sum(rejected.plots) + sum(rejected.bunds)).toBeCloseTo(sum([narrow]), 2)
    expect(sum(connected.plots) + sum(connected.bunds)).toBeCloseTo(sum([wide]), 2)
    expect(JSON.stringify([narrow, wide])).toBe(before)
  })
  it('reserves small-holding survey effort across a large district when coarse units cross uncultivable contour bands', () => {
    const input = fixture(), cultivable = (p: { y: number }) => Math.sin((p.y - 100) * Math.PI / 35) > .4
    input.regions = [{ polygon: rectangle(104, 100, 2000, 1000) }]
    input.road = { ...input.road, points: [{ x: 100, y: 50 }, { x: 100, y: 1150 }] }
    input.origin = { x: 100, y: 600 }; input.terrain.cultivable = cultivable
    const result = subdivideContinuousFarmDistrict(input)
    expect(result.plots.length).toBeGreaterThan(10)
    expect(result.plots.some(plot => boundsOf(plot.polygon).minY > 850)).toBe(true)
    expect(result.plots.some(plot => boundsOf(plot.polygon).maxY < 350)).toBe(true)
    for (const plot of result.plots) {
      expect(regionArea(plot)).toBeGreaterThanOrEqual(200)
      for (const p of plot.polygon) expect(cultivable(p)).toBe(true)
    }
    expect(Math.abs(result.diagnostics.areaError)).toBeLessThan(.01)
    expect(result.plots.length).toBeLessThanOrEqual(2048)
  })
  it('preserves the legacy coast03 narrow working holes while accepting only vehicle-served new holdings', () => {
    const source = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/continuous-farm-SE-bund.json.gz', import.meta.url))).toString()) as {
      regions: ContinuousFarmDistrictInput['regions']; road: ContinuousFarmDistrictInput['road']; origin: ContinuousFarmDistrictInput['origin']; seed: string
      terrainSurface: { cellSize: number; columns: number; rows: number; origin: { x: number; y: number }; elevations: number[] }
      waterAreas: ContinuousFarmDistrictInput['regions']; adjacentExistingPlots: ContinuousFarmDistrictInput['regions']
    }
    const saved = source.terrainSurface, elevation = (p: { x: number; y: number }) => {
      const x = Math.max(0, Math.min(saved.columns - 1, (p.x - saved.origin.x) / saved.cellSize)), y = Math.max(0, Math.min(saved.rows - 1, (p.y - saved.origin.y) / saved.cellSize)), ix = Math.floor(x), iy = Math.floor(y), u = x - ix, v = y - iy
      const value = (dx: number, dy: number) => saved.elevations[Math.min(saved.rows - 1, iy + dy) * saved.columns + Math.min(saved.columns - 1, ix + dx)]!
      return value(0, 0) * (1 - u) * (1 - v) + value(1, 0) * u * (1 - v) + value(0, 1) * (1 - u) * v + value(1, 1) * u * v
    }
    const input: ContinuousFarmDistrictInput = { ...source, terrain: { elevation, slope: p => Math.hypot(elevation({ x: p.x + 12.5, y: p.y }) - elevation({ x: p.x - 12.5, y: p.y }), elevation({ x: p.x, y: p.y + 12.5 }) - elevation({ x: p.x, y: p.y - 12.5 })) / 25, wetness: () => 0, channelAt: () => null, cultivable: () => true, waterAt: p => source.waterAreas.some(region => pointInRegion(p, region)) } }
    const before = JSON.stringify(source), result = subdivideContinuousFarmDistrict(input)
    // The unchanged historical holes have2m gaps. They cannot be counted as
    //2.4m tractor routes merely to recover the former13,000m² mass target.
    expect(result.plots.length).toBeGreaterThan(0)
    expect(result.diagnostics.workingLaneWidth).toBeGreaterThanOrEqual(2.4)
    expect(result.plots.length).toBeLessThanOrEqual(2048)
    for (const plot of result.plots) {
      expect(plot.polygon).toHaveLength(4)
      expect(regionArea(plot)).toBeGreaterThanOrEqual(200)
      expect(Math.min(...plot.polygon.map((p, i) => Math.hypot(p.x - plot.polygon[(i + 1) % 4]!.x, p.y - plot.polygon[(i + 1) % 4]!.y)))).toBeGreaterThanOrEqual(12)
      expect(sum(subtractRegions(plot, [...source.regions]))).toBeLessThan(.001)
      for (const old of source.adjacentExistingPlots) expect(sum(intersectRegions(plot, old))).toBeLessThan(.001)
      for (const bund of result.bunds) expect(sum(intersectRegions(plot, bund))).toBeLessThan(.001)
    }
    expect(Math.abs(result.diagnostics.areaError)).toBeLessThan(.01)
    expect(JSON.stringify(source)).toBe(before)
  })
})
