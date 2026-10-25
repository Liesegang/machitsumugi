import { expect, it } from 'vitest'
import { buildLayoutFirstRoads } from './layout-first-roads'
import type { LayoutFirstZone } from './layout-first-types'
import { distance, pointInPolygon, polygonArea, polygonOverlapsRegion, rectangle } from './geometry'
import { alignmentDiagnostics } from './road-alignment'

it('commits coverage collectors only with real closed-face gain and same-era public contacts', () => {
  const waterAt = () => false, elevation = () => 20, slope = () => 0
  const zones: LayoutFirstZone[] = [
    { id: 'old', center: { x: 700, y: 900 }, polygon: rectangle(300, 500, 800, 800), radius: 400, kind: 'historic', builtYear: 1650, density: .9, maximumFloors: 2 },
    { id: 'modern', center: { x: 1500, y: 900 }, polygon: rectangle(900, 300, 1200, 1200), radius: 600, kind: 'residential', builtYear: 1955, density: .9, maximumFloors: 6 },
  ]
  const result = buildLayoutFirstRoads({ environment: { width: 2400, height: 1800, core: null, areas: [], terrain: { waterAt, elevation, slope, bridgeSites: [], continuationTerrain: { waterAt, elevation, slope } } }, zones, center: zones[0]!.center, seed: 'coverage-contacts', settlement: 'regional-city', density: 90 })
  const records = result.diagnostics.coverage ?? [], collectors = result.roads.filter(road => road.reason === '未被覆の都市需要地を通り実公道へ戻る大街区の集散道路')
  expect(new Set(records.map(record => record.phase))).toEqual(new Set(['before-fallback', 'after-fallback']))
  for (const record of records) expect(record.attempted).toBeLessThanOrEqual(record.phase === 'before-fallback' ? 2 : 4)
  expect(collectors.length).toBeGreaterThan(0)
  expect(records.reduce((sum, record) => sum + record.accepted, 0)).toBe(collectors.length)
  expect(records.reduce((sum, record) => sum + record.coveredGain, 0)).toBeGreaterThan(10000)
  for (const record of records) expect(record.after - record.before).toBeCloseTo(record.coveredGain, 2)
  for (const road of collectors) {
    expect([1650, 1955]).toContain(road.builtYear)
    expect(alignmentDiagnostics(road.points).minimumRadius).toBeGreaterThanOrEqual(50 - 1e-6)
    for (const endpoint of [road.points[0]!, road.points.at(-1)!]) expect(result.roads.some(other => other.id !== road.id && other.builtYear <= road.builtYear && other.points.some(point => distance(point, endpoint) < 1e-7))).toBe(true)
  }
})

it('keeps buildable same-era closed neighbourhoods outside a reserved central compound', () => {
  const waterAt = () => false, elevation = () => 12, slope = () => 0, campus = { polygon: rectangle(680, 480, 440, 440) }
  const historic: LayoutFirstZone = { id: 'town', center: { x: 900, y: 700 }, radius: 480, kind: 'historic', builtYear: 1650, density: .8, maximumFloors: 4, angle: .12, polygon: rectangle(420, 220, 960, 960) }
  const result = buildLayoutFirstRoads({ environment: { width: 1800, height: 1400, core: null, areas: [], exactLandCost: true, landCost: point => pointInPolygon(point, campus.polygon) ? Infinity : 0, terrain: { waterAt, elevation, slope, bridgeSites: [], continuationTerrain: { waterAt, elevation, slope } } }, zones: [historic], reservedRegions: [campus], center: historic.center, seed: 'castle-surrounded-by-old-town' })
  const privateBlocks = result.blocks.filter(polygon => polygonArea(polygon) >= 1500 && polygonArea(polygon) <= 25000 && !polygonOverlapsRegion(polygon, campus) && polygon.every(point => pointInPolygon(point, historic.polygon)))
  expect(privateBlocks.length).toBeGreaterThan(5)
  for (const polygon of privateBlocks) for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, frontage = result.graph.nearest({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, .08)
    expect(frontage).not.toBeNull()
    expect(frontage!.road.builtYear).toBe(1650)
  }
})
