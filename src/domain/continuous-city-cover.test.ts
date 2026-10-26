import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { buildContinuousCityCover, continuousCoverDiagnostics, continuousRoadGround, dissolveContinuousCover, partitionContinuousCover, subtractContinuousCover } from './continuous-city-cover'
import type { ContinuousCityCoverInput } from './continuous-city-cover'
import type { ContinuousCityDemand } from './continuous-city-types'
import type { Area, CityConfig, Parcel, Road } from './types'
import { distanceToSegment, intersectRegions, pointInRegion, rectangle, regionArea, subtractRegions } from './geometry'
import type { PolygonRegion } from './geometry'
import { regionQuery } from './region-query'

const config: CityConfig = { name: '連続市街地', seed: 'continuous-cover', type: 'post', terrain: 'plain', density: 100, forest: 0, railway: false, stations: 0, arterial: true, facilities: [], targetYear: 2025 }
const demand = (regions: PolygonRegion[] = []): ContinuousCityDemand => ({ center: { x: 400, y: 300 }, regions, at: p => regions.some(r => pointInRegion(p, r)) ? 1 : 0, costAt: () => 0, openingAt: () => 1955, metrics: { cellSize: 100, reachableLandArea: 480000, targetUrbanArea: 0, selectedUrbanArea: 0 } })
const run = (overrides: Partial<ContinuousCityCoverInput> = {}) => buildContinuousCityCover({ config, width: 800, height: 600, terrain: { areas: [], elevation: () => 20, slope: () => 0, wetness: () => .1, waterAt: () => false }, demand: demand(), roads: [], parcels: [], reserves: [], urbanBlocks: [], ...overrides })
const sum = (regions: readonly PolygonRegion[]) => regions.reduce((s, r) => s + regionArea(r), 0)
const overlap = (a: PolygonRegion, b: PolygonRegion) => sum(intersectRegions(a, b))
const parcel: Parcel = { id: 'title', polygon: rectangle(100, 120, 70, 80), entrance: { x: 135, y: 120 }, roadId: 'road', createdYear: 1955, use: 'residential' }

describe('continuous city residual cover', () => {
  it('preserves exact water metadata and holes, including dry islands, and partitions the crop', () => {
    const lake: Area = { id: 'lake', kind: 'water', name: '島の湖', waterLevel: 10, polygon: rectangle(200, 100, 300, 350), holes: [rectangle(310, 230, 80, 80)] }
    const result = run({ terrain: { areas: [lake], elevation: () => 20, slope: () => 0, waterAt: p => pointInRegion(p, lake) } })
    expect(result.at(-1)).toBe(lake)
    expect(result.some(a => a.kind !== 'water' && pointInRegion({ x: 350, y: 270 }, a))).toBe(true)
    for (const a of result.filter(a => a.kind !== 'water')) expect(overlap(a, lake)).toBeLessThan(.001)
    expect(sum(result)).toBeCloseTo(480000, 3)
    for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) expect(overlap(result[i]!, result[j]!)).toBeLessThan(.001)
  })
  it('clears acquired titles, reserves and full ground ROW exactly without losing residual land', () => {
    const road: Road = { id: 'road', kind: 'local', width: 8, points: [{ x: 0, y: 110 }, { x: 800, y: 110 }] }
    const reserve = { polygon: rectangle(300, 100, 100, 200), holes: [rectangle(330, 180, 20, 30)] }
    const water: Area = { id: 'river', kind: 'water', polygon: rectangle(600, 0, 35, 600) }
    const retired = { ...parcel, id: 'retired', polygon: rectangle(450, 350, 60, 60), retiredYear: 2000 }
    const obstacles = [{ polygon: parcel.polygon }, reserve, ...continuousRoadGround(road), water]
    const result = run({ roads: [road], parcels: [parcel, retired], reserves: [reserve], terrain: { areas: [water], elevation: () => 10, slope: () => 0, waterAt: p => pointInRegion(p, water) } })
    const land = result.filter(a => a.kind !== 'water')
    for (const a of land) for (const obstacle of obstacles) expect(overlap(a, obstacle)).toBeLessThan(.001)
    const expected = sum(subtractRegions({ polygon: rectangle(0, 0, 800, 600) }, obstacles))
    expect(sum(land)).toBeCloseTo(expected, 2)
    expect(land.some(a => pointInRegion({ x: 480, y: 380 }, a))).toBe(true)
    expect(land.some(a => pointInRegion({ x: 340, y: 195 }, a))).toBe(true)
  })
  it('makes broad continuous rural districts from real access with different reach orientations', () => {
    const roads: Road[] = [
      { id: 'east-west', kind: 'local', role: 'farm', width: 4, points: [{ x: 0, y: 300 }, { x: 2200, y: 300 }] },
      { id: 'diagonal', kind: 'local', role: 'farm', width: 4, points: [{ x: 1500, y: 550 }, { x: 2200, y: 1100 }] },
    ]
    const result = run({ width: 2400, height: 1200, roads }), farms = result.filter(a => a.kind === 'field')
    expect(farms.length).toBeGreaterThan(5)
    expect(sum(farms)).toBeGreaterThan(2500000)
    expect(Math.max(...farms.map(regionArea))).toBeGreaterThan(200000)
    expect(new Set(farms.flatMap(f => f.polygon.map((a, i) => { const b = f.polygon[(i + 1) % f.polygon.length]!; return Math.round(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI / 10) }))).size).toBeGreaterThan(4)
    expect(farms.every(farm => farm.landUse === 'dry-field')).toBe(true)
    // Storage pieces can be remote from a road; each connected agricultural
    // holding must still reach real frontage across positive-width tile seams.
    for (const holding of dissolveContinuousCover(farms)) expect(roads.some(r => r.points.slice(1).some((b, i) => holding.polygon.some(p => distanceToSegment(p, r.points[i]!, b) <= r.width / 2 + .65)))).toBe(true)
    expect(result.some(a => a.kind === 'field' && pointInRegion({ x: 400, y: 1000 }, a))).toBe(true)
    expect(sum(result)).toBeGreaterThan(2800000)
  })
  it('keeps steep woodland continuous and gives disconnected dry land no invented farm access', () => {
    const lake: Area = { id: 'moat', kind: 'water', polygon: rectangle(350, 100, 250, 350), holes: [rectangle(410, 180, 90, 100)] }
    const result = run({ roads: [{ id: 'road', kind: 'local', width: 6, points: [{ x: 0, y: 80 }, { x: 800, y: 80 }] }], terrain: { areas: [lake], elevation: () => 20, slope: p => p.x > 650 ? .3 : 0, waterAt: p => pointInRegion(p, lake) } })
    expect(result.some(a => a.landUse === 'woodland' && pointInRegion({ x: 750, y: 400 }, a))).toBe(true)
    expect(result.some(a => a.landUse === 'meadow' && pointInRegion({ x: 450, y: 220 }, a))).toBe(true)
    expect(result.some(a => a.kind === 'field' && pointInRegion({ x: 450, y: 220 }, a))).toBe(false)
  })
  it('labels missing urban development as vacant and only makes bounded actual-block park pockets', () => {
    const support = { polygon: rectangle(0, 0, 800, 600) }
    const result = run({ demand: demand([support]), parcels: [parcel], urbanBlocks: [support] })
    expect(result.some(a => a.landUse === 'vacant' && pointInRegion({ x: 500, y: 300 }, a))).toBe(true)
    expect(result.some(a => a.landUse === 'meadow')).toBe(false)
    const pocket = { polygon: rectangle(100, 100, 30, 30) }, road: Road = { id: 'street', kind: 'local', width: 6, points: [{ x: 50, y: 97 }, { x: 170, y: 97 }] }
    const small = run({ demand: demand([pocket]), urbanBlocks: [pocket], roads: [road] })
    expect(small.some(a => a.kind === 'park' && a.landUse === undefined && regionArea(a) <= 1600)).toBe(true)
    expect(small.filter(a => a.kind !== 'water').every(a => a.name === undefined)).toBe(true)
  })
  it('classifies deep interior remnants and enclosed demand holes without changing the filled partition', () => {
    const support = { polygon: rectangle(40, 40, 720, 520), holes: [rectangle(300, 200, 120, 100)] }
    const titles = [parcel, { ...parcel, id: 'outside-title', polygon: rectangle(5, 120, 20, 30) }]
    const result = run({ demand: demand([support]), parcels: titles }), urban = result.filter(a => a.landUse === 'vacant')
    expect(sum(urban)).toBeCloseTo(720 * 520 - 120 * 100 - 70 * 80, 2)
    expect(urban.some(a => pointInRegion({ x: 700, y: 500 }, a))).toBe(true)
    expect(urban.some(a => pointInRegion({ x: 350, y: 250 }, a))).toBe(false)
    expect(urban.some(a => pointInRegion({ x: 20, y: 400 }, a))).toBe(false)
    expect(result.some(a => a.landUse === 'meadow' && pointInRegion({ x: 350, y: 250 }, a))).toBe(true)
    expect(sum(result)).toBeCloseTo(480000 - 70 * 80 - 20 * 30, 2)
    for (const a of result) for (const title of titles) expect(overlap(a, title)).toBeLessThan(.001)
  })
  it('is deterministic, leaves all inputs intact, and bounds whole-crop terrain sampling', () => {
    const input = { roads: [{ id: 'road', kind: 'local' as const, width: 6, points: [{ x: 0, y: 100 }, { x: 800, y: 100 }] }], parcels: [parcel] }, before = JSON.stringify(input)
    expect(run(input)).toEqual(run(input))
    expect(JSON.stringify(input)).toBe(before)
    let samples = 0
    const large = run({ width: 12000, height: 9000, terrain: { areas: [], elevation: () => 10, slope: () => { samples++; return 0 }, waterAt: () => false } })
    expect(samples).toBeLessThan(11000)
    expect(sum(large)).toBeCloseTo(108000000, 1)
  })
  it('unions thousands of thin touching verges without a floating sweep, retaining holes and nested dry islands', () => {
    const parts: PolygonRegion[] = [], ox = 6400, oy = 2400
    const add = (polygon: PolygonRegion['polygon'], reverse: boolean) => {
      // Repeated/closed vertices and inconsistent source winding are present
      // in real clipped verge fragments; neither can erase positive fill.
      const ring = reverse ? polygon.slice().reverse() : polygon.slice()
      ring.splice(1, 0, { ...ring[0]! }); ring.push({ ...ring[0]! })
      parts.push({ polygon: ring })
    }
    for (let i = 0; i < 1000; i++) {
      add(rectangle(ox + i * .6, oy, .6, 1), i % 2 === 0)
      add(rectangle(ox + i * .6, oy + 99, .6, 1), i % 2 !== 0)
      add(rectangle(ox, oy + i * .1, 1, .1), i % 2 === 0)
      add(rectangle(ox + 599, oy + i * .1, 1, .1), i % 2 !== 0)
    }
    parts.push({ polygon: rectangle(ox + 300, oy + 40, 1, 1) })
    const source = JSON.stringify(parts), result = dissolveContinuousCover(parts)
    expect(result).toHaveLength(2)
    expect(result.reduce((n, p) => n + (p.holes?.length ?? 0), 0)).toBe(1)
    expect(sum(result)).toBeCloseTo(600 * 100 - 598 * 98 + 1, 3)
    expect(result.some(r => pointInRegion({ x: ox + 300.5, y: oy + 40.5 }, r))).toBe(true)
    expect(result.some(r => pointInRegion({ x: ox + 200, y: oy + 40 }, r))).toBe(false)
    expect(result.some(r => pointInRegion({ x: ox + .5, y: oy + 40 }, r))).toBe(true)
    expect(JSON.stringify(parts)).toBe(source)
  })
  it('splits only portable-format hole overflow without losing or filling any land', () => {
    const holes = Array.from({ length: 10001 }, (_, i) => rectangle(10 + i % 101 * 8, 10 + Math.floor(i / 101) * 8, 2, 2))
    const source = { polygon: rectangle(0, 0, 1000, 1000), holes }, result = dissolveContinuousCover([source])
    expect(result.length).toBeGreaterThan(1)
    expect(result.every(r => r.polygon.length <= 32768 && (r.holes?.length ?? 0) <= 10000 && (r.holes ?? []).every(h => h.length <= 32768))).toBe(true)
    expect(sum(result)).toBeCloseTo(1000000 - 10001 * 4, 3)
    for (const i of [0, 100, 5000, 10000]) {
      const p = holes[i]![0]!
      expect(result.some(r => pointInRegion({ x: p.x + 1, y: p.y + 1 }, r))).toBe(false)
    }
    expect(result.some(r => pointInRegion({ x: 950, y: 950 }, r))).toBe(true)
  })
  it('dissolves a translated4x3km connected title-verge mesh while retaining all3000 holes', () => {
    const ox = 6400, oy = 2400, parts: PolygonRegion[] = []
    for (let x = 0; x < 100; x++) for (let y = 0; y < 30; y++) parts.push({ polygon: rectangle(ox + x * 40, oy + y * 100, 40, 100), holes: [rectangle(ox + x * 40 + .1, oy + y * 100 + .1, 39.8, 99.8)] })
    const started = performance.now(), result = dissolveContinuousCover(parts)
    expect(result).toHaveLength(1)
    expect(result[0]!.holes).toHaveLength(3000)
    expect(sum(result)).toBeCloseTo(12000000 - 3000 * 39.8 * 99.8, 2)
    expect(pointInRegion({ x: ox + 20, y: oy + 50 }, result[0]!)).toBe(false)
    expect(pointInRegion({ x: ox + .05, y: oy + 50 }, result[0]!)).toBe(true)
    console.info(`cover-only translated4x3km/3000-hole union: ${(performance.now() - started).toFixed(1)}ms`)
  }, 10000)
  it('does not transfer rural access across a point-only contact between processing tiles', () => {
    const result = run({ width: 1800, height: 1800, roads: [{ id: 'farm-road', kind: 'local', width: 4, points: [{ x: 0, y: 400 }, { x: 800, y: 400 }] }], reserves: [{ polygon: rectangle(900, 0, 900, 900) }, { polygon: rectangle(0, 900, 900, 900) }] })
    expect(result.some(a => a.kind === 'field' && pointInRegion({ x: 400, y: 200 }, a))).toBe(true)
    expect(result.some(a => a.kind === 'field' && pointInRegion({ x: 1200, y: 1200 }, a))).toBe(false)
    expect(result.some(a => a.landUse === 'meadow' && pointInRegion({ x: 1200, y: 1200 }, a))).toBe(true)
    expect(result.filter(a => a.kind !== 'water').every(a => a.id.startsWith('land-continuous-'))).toBe(true)
  })
  it('keeps the actual native1659-piece cadastre exact as a partition, with bounded generic union too', () => {
    const parts = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/continuous-cover-native-urban.json.gz', import.meta.url))).toString()) as PolygonRegion[]
    expect(parts).toHaveLength(1659)
    const start = performance.now(), partition = partitionContinuousCover(parts)
    expect(partition).toHaveLength(parts.length)
    expect(partition.every((part, i) => part === parts[i])).toBe(true)
    expect(sum(partition)).toBe(sum(parts))
    const inputVertices = parts.reduce((n, p) => n + p.polygon.length + (p.holes ?? []).reduce((s, h) => s + h.length, 0), 0), united = dissolveContinuousCover(parts)
    // The captured tile interiors are disjoint: an independent union preserves
    // their sum within0.1m² across1.895km² at the0.1mm survey lattice.
    expect(Math.abs(sum(united) - sum(parts))).toBeLessThan(.1)
    expect(united.reduce((n, p) => n + p.polygon.length + (p.holes ?? []).reduce((s, h) => s + h.length, 0), 0)).toBeLessThan(inputVertices * 1.2)
    expect(united.reduce((n, p) => n + (p.holes?.length ?? 0), 0)).toBe(2715)
    console.info(`actual native1659-piece cover partition + generic union: ${(performance.now() - start).toFixed(1)}ms`)
  }, 10000)
  it('retains subject holes and dry islands when a high-operand acquisition difference uses integers', () => {
    const subject = { polygon: rectangle(1800, 0, 900, 900), holes: [rectangle(1850, 50, 30, 30)] }, acquisition = { polygon: rectangle(1900, 100, 600, 600), holes: [rectangle(2100, 300, 200, 200)] }
    const cuts = Array.from({ length: 512 }, () => acquisition), original = JSON.stringify({ subject, cuts }), result = subtractContinuousCover(subject, cuts)
    expect(sum(result)).toBeCloseTo(sum(subtractRegions(subject, [acquisition])), 4)
    expect(result.some(r => pointInRegion({ x: 2150, y: 350 }, r))).toBe(true)
    expect(result.some(r => pointInRegion({ x: 1950, y: 150 }, r))).toBe(false)
    expect(result.some(r => pointInRegion({ x: 1860, y: 60 }, r))).toBe(false)
    expect(JSON.stringify({ subject, cuts })).toBe(original)
  })
  it('replays the actual2999-boundary tile against its independently computed exclusion set', () => {
    // GEOS/Shapely2.0.7 computes cell minus unary_union(all exact cuts).
    // The former floating result painted4,834.58m² of acquired private ground;
    // preserving that output would preserve the defect rather than the set.
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/continuous-cover-difference-tile.json.gz', import.meta.url))).toString()) as { subject: PolygonRegion; cuts: PolygonRegion[]; expected: PolygonRegion[]; original: PolygonRegion[]; originalExcludedOverlap: number }
    expect(fixture.cuts).toHaveLength(2999)
    const original = JSON.stringify(fixture), started = performance.now(), result = subtractContinuousCover(fixture.subject, fixture.cuts), milliseconds = performance.now() - started
    const areaDifference = Math.abs(sum(result) - sum(fixture.expected)), expectedAt = regionQuery(fixture.expected), resultAt = regionQuery(result)
    expect(areaDifference).toBeLessThan(.1)
    for (let x = 1803.37; x < 2700; x += 13.37) for (let y = 3.91; y < 900; y += 13.37) expect(resultAt({ x, y })).toBe(expectedAt({ x, y }))
    const acquiredInterior = { x: 2217.84, y: 137.61 }
    expect(fixture.originalExcludedOverlap).toBeGreaterThan(4834)
    expect(regionQuery(fixture.original)(acquiredInterior)).toBe(true)
    expect(regionQuery(fixture.cuts)(acquiredInterior)).toBe(true)
    expect(resultAt(acquiredInterior)).toBe(false)
    for (const part of result) expect(sum(subtractRegions(part, [fixture.subject]))).toBeLessThan(.001)
    expect(JSON.stringify(fixture)).toBe(original)
    console.info(`actual2999-cut cover difference: ${milliseconds.toFixed(1)}ms; area delta ${areaDifference.toFixed(6)}m²; ${result.length} residual pieces`)
  }, 10000)
  it('classifies a grid-collapsed derived needle without deleting its raw source or a meaningful hole', () => {
    const needle = [{ x: 5313.213447328113, y: 3378.2676703986804 }, { x: 5312.853818923021, y: 3378.437730058252 }, { x: 5311.400958565827, y: 3379.124752924776 }, { x: 5312.853818923021, y: 3378.437730058253 }]
    const parent = { polygon: rectangle(5300, 3360, 30, 30), holes: [needle, rectangle(5302, 3362, .5, .5)] }, other = { polygon: rectangle(5329, 3360, 2, 30) }, parts = [parent, other], before = JSON.stringify(parts), diagnostics = { ...continuousCoverDiagnostics }
    const result = dissolveContinuousCover(parts)
    expect(sum(result)).toBeCloseTo(31 * 30 - .25, 5)
    expect(result.some(part => pointInRegion({ x: 5302.25, y: 3362.25 }, part))).toBe(false)
    expect(continuousCoverDiagnostics.collapsedHoles).toBeGreaterThan(diagnostics.collapsedHoles)
    expect(continuousCoverDiagnostics.collapsedRawFilledArea - diagnostics.collapsedRawFilledArea).toBeGreaterThan(0)
    expect(continuousCoverDiagnostics.collapsedRawFilledArea - diagnostics.collapsedRawFilledArea).toBeLessThan(1e-10)
    expect(JSON.stringify(parts)).toBe(before)
  })
  it('retains both positive lobes of signed-zero figure eights as acquisitions and holes', () => {
    const figure = [{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }, { x: 20, y: 0 }], square = { polygon: rectangle(0, 0, 30, 30) }
    const acquisition = subtractContinuousCover(square, Array.from({ length: 512 }, () => ({ polygon: figure })))
    expect(sum(acquisition)).toBeCloseTo(700, 5)
    expect(acquisition.some(part => pointInRegion({ x: 10, y: 3 }, part))).toBe(false)
    expect(acquisition.some(part => pointInRegion({ x: 10, y: 17 }, part))).toBe(false)
    const holed = subtractContinuousCover({ ...square, holes: [figure] }, Array.from({ length: 512 }, () => ({ polygon: rectangle(25, 25, 1, 1) })))
    expect(sum(holed)).toBeCloseTo(699, 5)
    expect(holed.some(part => pointInRegion({ x: 3, y: 10 }, part))).toBe(true)
    expect(holed.some(part => pointInRegion({ x: 10, y: 3 }, part))).toBe(false)
  })
  it('replays native08 first failed union within its existing fixed-grid boundary error band', () => {
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/continuous-cover-native08-zero-hole.json.gz', import.meta.url))).toString()) as { parts: PolygonRegion[]; expected: PolygonRegion[]; boundaryBandArea: number }
    expect(fixture.parts).toHaveLength(9)
    const source = JSON.stringify(fixture), result = dissolveContinuousCover(fixture.parts)
    // Independent GEOS additionally proves XOR outside the0.2mm input-edge
    // buffer is exactly zero; all raw rings, blocks and road stock are intact.
    expect(Math.abs(sum(result) - sum(fixture.expected))).toBeLessThan(fixture.boundaryBandArea)
    const actual = regionQuery(result), expected = regionQuery(fixture.expected)
    for (let y = 17.23; y < 9000; y += 173.19) for (let x = 29.17; x < 12000; x += 173.19) expect(actual({ x, y })).toBe(expected({ x, y }))
    expect(result.every(part => Number.isFinite(regionArea(part)) && regionArea(part) > 0)).toBe(true)
    expect(JSON.stringify(fixture)).toBe(source)
  }, 10000)
})
