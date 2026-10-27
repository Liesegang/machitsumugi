import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { subdivideContinuousFarmDistrict } from './continuous-city-farm-plots'
import type { ContinuousFarmDistrictInput } from './continuous-city-farm-plots'
import { boundsOf, distanceToSegment, intersectRegions, pointInRegion, polygonOverlapsRegion, rectangle, regionArea, subtractRegions } from './geometry'

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
  it('packs the actual uncut coast03 residual without leaving its broad interior labelled as grassed bunds', () => {
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
    const before = JSON.stringify(source), result = subdivideContinuousFarmDistrict(input), allFields = [...source.adjacentExistingPlots, ...result.plots], distances: number[] = [], bounds = boundsOf(source.regions.flatMap(region => region.polygon))
    for (let x = bounds.minX + 4; x < bounds.maxX; x += 8) for (let y = bounds.minY + 4; y < bounds.maxY; y += 8) {
      const p = { x, y }
      if (!source.regions.some(region => pointInRegion(p, region)) || result.plots.some(plot => pointInRegion(p, plot))) continue
      distances.push(Math.min(...allFields.flatMap(plot => plot.polygon.map((a, i) => distanceToSegment(p, a, plot.polygon[(i + 1) % plot.polygon.length]!)))))
    }
    distances.sort((a, b) => a - b)
    expect(sum(result.plots)).toBeGreaterThan(13000)
    expect(distances[Math.floor((distances.length - 1) * .9)]).toBeLessThan(15)
    expect(Math.max(...distances)).toBeLessThan(25)
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
