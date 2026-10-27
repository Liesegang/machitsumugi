import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { buildContinuousCityLandDomains } from './continuous-city-land-domains'
import { developContinuousCityLand } from './continuous-city-land'
import type { ContinuousCityBlock, ContinuousCityLandInput } from './continuous-city-types'
import type { PolygonRegion } from './geometry'
import type { Area, CityConfig } from './types'
import { distanceToSegment, intersectRegions, pointInPolygon, pointInRegion, polygonArea, rectangle, regionArea } from './geometry'
import { regionQuery } from './region-query'

const sum = (regions: readonly PolygonRegion[]) => regions.reduce((total, region) => total + regionArea(region), 0)
const overlap = (a: PolygonRegion, b: PolygonRegion) => sum(intersectRegions(a, b))
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) freeze(item) }
  return value
}
const config: CityConfig = { name: '未閉外縁', seed: 'actual-open-frontage', type: 'newtown', terrain: 'plain', density: 80, forest: 0, railway: false, stations: 0, arterial: true, facilities: [], settlement: 'metropolis', targetYear: 2025, cityEngine: 'continuous' }

describe('continuous city ownership domains beyond closed street faces', () => {
  it('retains actual face references and conserves overlapping demand, holes and nested residual islands', () => {
    const demandRegions = freeze([{ polygon: rectangle(0, 0, 200, 150), holes: [rectangle(80, 50, 40, 30)] }, { polygon: rectangle(180, 0, 120, 150) }])
    const streetBlocks = freeze<ContinuousCityBlock[]>([
      { id: 'actual-a', polygon: rectangle(20, 20, 40, 50), holes: [rectangle(30, 35, 10, 20)] },
      { id: 'actual-b', polygon: rectangle(150, 30, 30, 80) },
    ])
    const before = JSON.stringify({ demandRegions, streetBlocks }), result = buildContinuousCityLandDomains({ demandRegions, streetBlocks })
    expect(result.domains[0]).toBe(streetBlocks[0])
    expect(result.domains[1]).toBe(streetBlocks[1])
    expect(sum(result.fringe)).toBeCloseTo(39600, 3)
    expect(sum(result.fringe) + sum(streetBlocks)).toBeCloseTo(43800, 3)
    expect(result.metrics.demandArea).toBeCloseTo(43800, 3)
    expect(result.fringe.some(region => pointInRegion({ x: 35, y: 45 }, region))).toBe(true)
    expect(result.fringe.some(region => pointInRegion({ x: 100, y: 65 }, region))).toBe(false)
    for (let i = 0; i < result.fringe.length; i++) {
      for (const block of streetBlocks) expect(overlap(result.fringe[i]!, block)).toBeLessThan(.001)
      for (let j = i + 1; j < result.fringe.length; j++) expect(overlap(result.fringe[i]!, result.fringe[j]!)).toBeLessThan(.001)
      expect(Object.keys(result.fringe[i]!).every(key => ['id', 'polygon', 'holes'].includes(key))).toBe(true)
    }
    expect(JSON.stringify({ demandRegions, streetBlocks })).toBe(before)
    expect(buildContinuousCityLandDomains({ demandRegions, streetBlocks })).toEqual(result)
  })

  it('does not duplicate fringe for repeated demand or overlapping closed-face cuts, and avoids source-id collisions', () => {
    const demand = { polygon: rectangle(0, 0, 100, 100) }
    const streetBlocks = [{ id: 'continuous-fringe-0', polygon: rectangle(20, 20, 30, 30) }, { id: 'second', polygon: rectangle(40, 20, 30, 30) }]
    const result = buildContinuousCityLandDomains({ demandRegions: [demand, demand, { polygon: [...demand.polygon] }], streetBlocks })
    expect(result.domains.slice(0, 2)).toEqual(streetBlocks)
    expect(result.domains[0]).toBe(streetBlocks[0])
    expect(result.fringe).toHaveLength(1)
    expect(result.fringe[0]!.id).not.toBe(streetBlocks[0]!.id)
    expect(sum(result.fringe)).toBeCloseTo(8500, 3)
    expect(result.metrics.coveredDemandArea).toBeCloseTo(1500, 3)
    for (const block of streetBlocks) expect(overlap(result.fringe[0]!, block)).toBeLessThan(.001)
    expect(buildContinuousCityLandDomains({ demandRegions: [], streetBlocks }).domains[0]).toBe(streetBlocks[0])
    expect(buildContinuousCityLandDomains({ demandRegions: [demand], streetBlocks: [{ id: 'all', ...demand }] }).fringe).toEqual([])
  })

  it('uses the validated large difference without tiling or losing a demand hole', () => {
    const demand = freeze({ polygon: rectangle(0, 0, 2000, 1000), holes: [rectangle(100, 100, 20, 30)] })
    const streetBlocks = freeze(Array.from({ length: 600 }, (_, i) => ({ id: `actual-${i}`, polygon: rectangle(400 + i * 2, 300, 2, 400) })))
    const before = JSON.stringify({ demand, streetBlocks }), result = buildContinuousCityLandDomains({ demandRegions: [demand], streetBlocks })
    expect(result.metrics.boundedDifferences).toBe(1)
    expect(result.fringe).toHaveLength(1)
    expect(result.fringe[0]!.holes).toHaveLength(2)
    expect(sum(result.fringe) + sum(streetBlocks)).toBeCloseTo(1_999_400, 2)
    expect(result.domains).toHaveLength(601)
    expect(result.domains.slice(0, 600).every((block, i) => block === streetBlocks[i])).toBe(true)
    expect(JSON.stringify({ demand, streetBlocks })).toBe(before)
  })

  it('lets an actual unclosed street acquire only its real frontage without treating fringe boundaries as roads', () => {
    const water: Area = { id: 'unchanged-water', kind: 'water', name: '池', waterLevel: 7, polygon: rectangle(110, 30, 18, 10) }
    const demandRegions = [{ polygon: rectangle(20, 25, 240, 50), holes: [water.polygon] }, { polygon: rectangle(20, 110, 80, 25) }]
    const ownership = buildContinuousCityLandDomains({ demandRegions, streetBlocks: [] })
    const road = { id: 'actual-open-road', kind: 'local' as const, role: 'lane' as const, width: 6, builtYear: 1900, points: [{ x: 0, y: 50 }, { x: 300, y: 50 }] }
    const source = JSON.stringify({ water, road, demandRegions })
    const input: ContinuousCityLandInput = {
      config, width: 300, height: 180, roads: [road], blocks: ownership.domains, stations: [], reserves: [],
      terrain: { areas: [water], elevation: () => 20, slope: () => 0, waterAt: p => pointInRegion(p, water) },
      demand: { center: { x: 150, y: 50 }, regions: demandRegions, at: p => demandRegions.some(region => pointInRegion(p, region)) ? .65 : 0, costAt: () => 0, openingAt: () => 1900, metrics: { cellSize: 25, reachableLandArea: 13820, targetUrbanArea: 13820, selectedUrbanArea: 13820 } },
    }
    const result = developContinuousCityLand(input)
    expect(ownership.fringe).toHaveLength(2)
    expect(result.parcels.length).toBeGreaterThan(10)
    expect(result.accessRoads).toEqual([])
    expect(result.metrics.partitionAreaError).toBeLessThan(.1)
    expect(result.parcels.every(parcel => parcel.roadId === road.id && parcel.createdYear >= 1900)).toBe(true)
    expect(result.parcels.every(parcel => parcel.polygon.every(p => p.y < 80))).toBe(true)
    for (const parcel of result.parcels) {
      expect(distanceToSegment(parcel.access![0]!, road.points[0]!, road.points[1]!)).toBeLessThan(.001)
      expect(Math.abs(Math.abs(parcel.entrance.y - 50) - 3.25)).toBeLessThan(.01)
      expect(overlap(parcel, water)).toBeLessThan(.001)
    }
    const parcels = new Map(result.parcels.map(parcel => [parcel.id, parcel]))
    for (const building of result.buildings) {
      expect(building.polygon.every(p => pointInPolygon(p, parcels.get(building.parcelId!)!.polygon))).toBe(true)
      expect(polygonArea(building.polygon)).toBeGreaterThanOrEqual(30)
      expect(overlap(building, water)).toBeLessThan(.001)
    }
    expect(Object.keys(ownership).sort()).toEqual(['domains', 'fringe', 'metrics'])
    expect(JSON.stringify({ water, road, demandRegions })).toBe(source)
  })

  it('replays the actual892-face coarse complement without reapplying thousands of touching hole edges', () => {
    // Independent GEOS demand-minus-union truth; its one weak source ring was
    // interpreted without removing any positive lobe. All original face refs
    // remain intact, and residual fill follows the existing0.1mm survey bound.
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/continuous-land-domains-coarse.json.gz', import.meta.url))).toString()) as { demandRegions: PolygonRegion[]; streetBlocks: ContinuousCityBlock[]; expected: PolygonRegion[] }
    expect(fixture.streetBlocks).toHaveLength(892)
    const before = JSON.stringify(fixture), started = performance.now(), result = buildContinuousCityLandDomains(fixture), milliseconds = performance.now() - started
    expect(result.metrics.boundedDifferences).toBe(1)
    expect(result.domains.slice(0, fixture.streetBlocks.length).every((block, i) => block === fixture.streetBlocks[i])).toBe(true)
    expect(Math.abs(sum(result.fringe) - sum(fixture.expected))).toBeLessThan(.1)
    const expectedAt = regionQuery(fixture.expected), actualAt = regionQuery(result.fringe)
    for (let y = 7.13; y < 1600; y += 23.71) for (let x = 11.97; x < 2000; x += 23.71) expect(actualAt({ x, y })).toBe(expectedAt({ x, y }))
    expect(JSON.stringify(fixture)).toBe(before)
    expect(milliseconds).toBeLessThan(2000)
    console.info(`actual892-face ownership complement: ${milliseconds.toFixed(1)}ms; ${result.fringe.length} residual pieces`)
  }, 5000)

  it('bounds the working union of the actual834 curved arterial faces while preserving their geometry and residual fill', () => {
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/continuous-land-domains-arterial.json.gz', import.meta.url))).toString()) as { demandRegions: PolygonRegion[]; streetBlocks: ContinuousCityBlock[]; expectedFringe: PolygonRegion[] }
    expect(fixture.streetBlocks).toHaveLength(834)
    const before = JSON.stringify(fixture), started = performance.now(), result = buildContinuousCityLandDomains(fixture), milliseconds = performance.now() - started
    expect(result.metrics.boundedDifferences).toBe(1)
    expect(result.domains.slice(0, fixture.streetBlocks.length).every((block, i) => block === fixture.streetBlocks[i])).toBe(true)
    expect(result.fringe).toHaveLength(fixture.expectedFringe.length)
    expect(Math.abs(sum(result.fringe) - sum(fixture.expectedFringe))).toBeLessThan(.1)
    const expectedAt = regionQuery(fixture.expectedFringe), actualAt = regionQuery(result.fringe)
    for (let y = 7.13; y < 1600; y += 23.71) for (let x = 11.97; x < 2000; x += 23.71) expect(actualAt({ x, y })).toBe(expectedAt({ x, y }))
    expect(JSON.stringify(fixture)).toBe(before)
    expect(milliseconds).toBeLessThan(2000)
  }, 5000)
})
