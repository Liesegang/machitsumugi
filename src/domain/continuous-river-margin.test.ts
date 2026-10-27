import { describe, expect, it } from 'vitest'
import type { Area, CityConfig, Point, Road } from './types'
import type { ContinuousRiverMarginInput } from './continuous-river-margin'
import { buildContinuousRiverMargins, continuousRiverMarginCover } from './continuous-river-margin'
import { continuousRoadGround } from './continuous-city-cover'
import { buildContinuousCoverHistory, continuousRoadAcquisitions } from './continuous-city-cover-history'
import { developContinuousCityLand } from './continuous-city-land'
import { intersectRegions, pointInRegion, rectangle, regionArea } from './geometry'

const river = (width: number): Area => ({ id: 'river', kind: 'water', polygon: rectangle(250 - width / 2, 0, width, 400) })
const input = (width: number, elevation: (point: Point) => number = () => .5): ContinuousRiverMarginInput => {
  const water = river(width)
  return { width: 500, height: 400, terrain: { areas: [water], elevation, waterAt: p => pointInRegion(p, water), channelAt: p => ({ point: { x: 250, y: p.y }, tangent: { x: 0, y: 1 }, bankDistance: Math.max(0, Math.abs(p.x - 250) - width / 2), width, surfaceElevation: 0, riverId: 'river' }) } }
}
const area = (parts: { polygon: Point[]; holes?: Point[][] }[]) => parts.reduce((sum, part) => sum + regionArea(part), 0)
const overlaps = (a: { polygon: Point[]; holes?: Point[][] }, b: { polygon: Point[]; holes?: Point[][] }) => area(intersectRegions(a, b))

describe('continuous surveyed riverbank ground', () => {
  it('keeps a small stream margin narrow while a broad low river retains a flood bench', () => {
    const stream = buildContinuousRiverMargins(input(4)), broad = buildContinuousRiverMargins(input(100))
    expect(stream.metrics.maximumWidth).toBeLessThan(4)
    expect(broad.metrics.minimumWidth).toBeGreaterThan(20)
    expect(stream.reserves.some(part => pointInRegion({ x: 246, y: 200 }, part))).toBe(true)
    expect(stream.reserves.some(part => pointInRegion({ x: 238, y: 200 }, part))).toBe(false)
    expect(broad.reserves.some(part => pointInRegion({ x: 185, y: 200 }, part))).toBe(true)
    expect(broad.areas.every(part => part.kind === 'park' && part.landUse === 'meadow')).toBe(true)
  })

  it('retains a narrow terrace setback on one bank without erasing the opposite low flood bench', () => {
    const margins = buildContinuousRiverMargins(input(100, p => p.x < 200 ? 12 : .5))
    expect(margins.reserves.some(part => pointInRegion({ x: 197, y: 200 }, part))).toBe(true)
    expect(margins.reserves.some(part => pointInRegion({ x: 185, y: 200 }, part))).toBe(false)
    expect(margins.reserves.some(part => pointInRegion({ x: 315, y: 200 }, part))).toBe(true)
    expect(margins.metrics.maximumWidth - margins.metrics.minimumWidth).toBeGreaterThan(15)
  })

  it('follows changing channel width and a rising bank instead of imposing one rectangular corridor', () => {
    const source = input(40, p => p.x > 270 ? Math.max(.4, (p.x - 275) * .5) : .4)
    source.terrain.channelAt = p => ({ point: { x: 250, y: p.y }, tangent: { x: 0, y: 1 }, bankDistance: Math.max(0, Math.abs(p.x - 250) - 20), width: 20 + p.y * .2, surfaceElevation: 0, riverId: 'river' })
    const margins = buildContinuousRiverMargins(source)
    expect(margins.reserves.some(part => pointInRegion({ x: 220, y: 30 }, part))).toBe(false)
    expect(margins.reserves.some(part => pointInRegion({ x: 220, y: 350 }, part))).toBe(true)
    expect(margins.reserves.some(part => pointInRegion({ x: 285, y: 350 }, part))).toBe(false)
    expect(margins.metrics.maximumWidth).toBeGreaterThan(margins.metrics.minimumWidth * 2)
  })

  it('keeps every source water and dry island exact and does not reserve lake or sea shores', () => {
    const source = input(100), channel = { ...source.terrain.areas[0]!, holes: [rectangle(230, 170, 40, 60)] }
    const lake: Area = { id: 'lake', kind: 'water', waterLevel: 0, polygon: rectangle(160, 150, 25, 45) }, sea: Area = { id: 'sea', kind: 'water', waterLevel: 0, polygon: rectangle(300, 330, 200, 70) }
    source.terrain.areas = [channel, lake, sea]
    source.terrain.waterAt = p => source.terrain.areas.some(part => pointInRegion(p, part))
    const before = JSON.stringify(source.terrain.areas), margins = buildContinuousRiverMargins(source)
    expect(JSON.stringify(source.terrain.areas)).toBe(before)
    for (const bank of margins.reserves) for (const water of source.terrain.areas) expect(overlaps(bank, water)).toBeLessThan(.001)
    expect(margins.reserves.some(part => pointInRegion({ x: 232, y: 200 }, part))).toBe(true)
    expect(margins.reserves.some(part => pointInRegion({ x: 160, y: 200 }, part))).toBe(false)
    expect(margins.reserves.some(part => pointInRegion({ x: 450, y: 320 }, part))).toBe(false)
  })

  it('is deterministic, bounded to the crop, and leaves nonriver terrain unchanged', () => {
    const source = input(80), before = JSON.stringify(source.terrain.areas), first = buildContinuousRiverMargins(source)
    expect(buildContinuousRiverMargins(source)).toEqual(first)
    expect(JSON.stringify(source.terrain.areas)).toBe(before)
    expect(first.reserves.every(part => part.polygon.every(p => p.x >= 0 && p.x <= 500 && p.y >= 0 && p.y <= 400))).toBe(true)
    expect(buildContinuousRiverMargins({ ...source, terrain: { ...source.terrain, areas: [{ ...river(80), id: 'lake' }] } }).reserves).toEqual([])
  })

  it('keeps the historical bank until a later public crossing actually acquires that ground', () => {
    const margins = buildContinuousRiverMargins(input(20)), bridge: Road = { id: 'later-bridge', kind: 'arterial', width: 10, bridge: true, points: [{ x: 0, y: 200 }, { x: 500, y: 200 }], builtYear: 1955 }
    const final = continuousRiverMarginCover(margins, continuousRoadGround(bridge))
    const history = buildContinuousCoverHistory({ width: 500, height: 400, baseCover: margins.areas, finalCover: final, acquisitions: continuousRoadAcquisitions([bridge]) })
    const hasBank = (point: Point, year: number) => history.some(version => version.from <= year && (version.to === undefined || version.to > year) && pointInRegion(point, version.value))
    expect(hasBank({ x: 237, y: 200 }, 1850)).toBe(true)
    expect(hasBank({ x: 237, y: 200 }, 1960)).toBe(false)
    expect(hasBank({ x: 237, y: 200 }, 2025)).toBe(false)
    expect(hasBank({ x: 237, y: 150 }, 1850)).toBe(true)
    expect(hasBank({ x: 237, y: 150 }, 2025)).toBe(true)
  })

  it('excludes private roofs while preserving an actual public crossing and clearing its visible pavement', () => {
    const source = input(20), margins = buildContinuousRiverMargins(source)
    const config: CityConfig = { name: '河岸試験市', seed: 'river-margin', type: 'post', terrain: 'plain', density: 100, forest: 0, railway: false, stations: 0, arterial: true, facilities: [], targetYear: 2025, settlement: 'regional-city' }
    const roads: Road[] = [
      { id: 'north', kind: 'local', width: 6, points: [{ x: 0, y: 20 }, { x: 500, y: 20 }], builtYear: 1955 },
      { id: 'south', kind: 'local', width: 6, points: [{ x: 0, y: 380 }, { x: 500, y: 380 }], builtYear: 1955 },
      { id: 'west', kind: 'local', width: 6, points: [{ x: 20, y: 20 }, { x: 20, y: 380 }], builtYear: 1955 },
      { id: 'east', kind: 'local', width: 6, points: [{ x: 480, y: 20 }, { x: 480, y: 380 }], builtYear: 1955 },
      { id: 'bridge', kind: 'arterial', width: 10, bridge: true, points: [{ x: 0, y: 200 }, { x: 500, y: 200 }], builtYear: 1955 },
    ]
    const before = JSON.stringify(roads), demand = { center: { x: 150, y: 200 }, regions: [{ polygon: rectangle(0, 0, 500, 400) }], at: () => .65, costAt: () => 1, openingAt: () => 1955, metrics: { cellSize: 40, reachableLandArea: 200000, targetUrbanArea: 200000, selectedUrbanArea: 200000 } }
    const land = developContinuousCityLand({ config, width: 500, height: 400, roads, blocks: [{ id: 'both-banks', polygon: rectangle(20, 20, 460, 360) }], stations: [], reserves: margins.reserves, terrain: { ...source.terrain, slope: () => 0 }, demand })
    expect(land.buildings.length).toBeGreaterThan(30)
    for (const roof of land.buildings) for (const bank of margins.reserves) expect(overlaps(roof, bank)).toBeLessThan(.001)
    const ground = roads.flatMap(continuousRoadGround), cover = continuousRiverMarginCover(margins, ground)
    expect(cover.length).toBeGreaterThan(0)
    for (const bank of cover) for (const pavement of ground) expect(overlaps(bank, pavement)).toBeLessThan(.001)
    expect(cover.some(part => pointInRegion({ x: 237, y: 200 }, part))).toBe(false)
    expect(cover.some(part => pointInRegion({ x: 237, y: 150 }, part))).toBe(true)
    expect(JSON.stringify(roads)).toBe(before)
    expect(land.metrics.partitionAreaError).toBeLessThan(.1)
  })
})
