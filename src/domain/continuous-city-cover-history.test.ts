import { describe, expect, it } from 'vitest'
import { buildContinuousCoverHistory, continuousRoadAcquisitions } from './continuous-city-cover-history'
import type { Area } from './types'
import { pointInRegion, rectangle, regionArea, subtractRegions } from './geometry'

describe('continuous cover acquisition history', () => {
  it('clears real bend shoulders at opening while retaining fields under elevated roads', () => {
    const road = { id: 'bend', kind: 'local' as const, width: 10, builtYear: 1955, points: [{ x: 20, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 150 }] }
    const acquisitions = continuousRoadAcquisitions([road])
    const base: Area = { id: 'base', kind: 'field', polygon: rectangle(0, 0, 200, 200) }
    const finalCover: Area[] = subtractRegions(base, acquisitions.map(a => a.region)).map((region, index) => ({ ...region, id: 'final-' + index, kind: 'field' }))
    const history = buildContinuousCoverHistory({ width: 200, height: 200, baseCover: [base], finalCover, acquisitions })
    const groundAt = (year: number) => history.some(v => v.from <= year && (v.to === undefined || year < v.to) && pointInRegion({ x: 103, y: 47 }, v.value))
    expect(groundAt(1954)).toBe(true)
    expect(groundAt(1955)).toBe(false)
    expect(groundAt(2025)).toBe(false)
    expect(continuousRoadAcquisitions([{ ...road, level: 1 }])).toEqual([])
  })
  it('restores base cover until earliest acquisition, conserves tiles and preserves exact water islands', () => {
    const water: Area = { id: 'natural-water', kind: 'water', name: '湖', polygon: rectangle(340, 20, 40, 60), holes: [rectangle(350, 40, 15, 15)], waterLevel: 7 }
    const forest: Area = { id: 'forest', kind: 'forest', polygon: rectangle(0, 0, 720, 160), holes: [water.polygon] }, island: Area = { id: 'island', kind: 'forest', polygon: water.holes![0]! }
    const acquisitions = [{ region: { polygon: rectangle(300, 0, 30, 160) }, from: 1900 }, { region: { polygon: rectangle(310, 0, 60, 160) }, from: 1955 }, { region: { polygon: rectangle(580, 30, 50, 50) }, from: 2025 }]
    const baseCover = [forest, island, water], cuts = acquisitions.map(entry => entry.region)
    const finalCover: Area[] = [...[forest, island].flatMap((base, index) => subtractRegions(base, cuts).map((region, piece): Area => ({ ...base, ...region, holes: region.holes, id: `final-${index}-${piece}` }))), water]
    const input = { width: 720, height: 160, baseCover, finalCover, acquisitions }, immutable = JSON.stringify(input)
    const history = buildContinuousCoverHistory(input), at = (year: number) => history.filter(version => version.from <= year && (version.to === undefined || year < version.to)).map(version => version.value)
    const forestAt = (year: number, x: number, y: number) => at(year).some(area => area.kind === 'forest' && pointInRegion({ x, y }, area))
    expect(forestAt(1850, 315, 10)).toBe(true)
    expect(forestAt(1900, 315, 10)).toBe(false)
    expect(forestAt(1900, 360, 100)).toBe(true)
    expect(forestAt(1955, 360, 100)).toBe(false)
    expect(forestAt(2024, 600, 50)).toBe(true)
    expect(forestAt(2025, 600, 50)).toBe(false)
    expect(forestAt(1900, 355, 45)).toBe(true)
    expect(forestAt(1955, 355, 45)).toBe(false)
    for (const year of [1650, 1850, 1900, 1955, 2024, 2025]) {
      expect(at(year).filter(area => area.kind === 'water')).toHaveLength(1)
      const restored = at(year).find(area => area.kind === 'water')!
      expect(restored.polygon).toEqual(water.polygon); expect(restored.holes).toEqual(water.holes); expect(restored.waterLevel).toBe(7)
      expect(pointInRegion({ x: 355, y: 30 }, restored)).toBe(true)
      expect(pointInRegion({ x: 355, y: 45 }, restored)).toBe(false)
      const expectedGround = [forest, island].flatMap(base => subtractRegions(base, acquisitions.filter(entry => entry.from <= year).map(entry => entry.region)))
      const expectedArea = expectedGround.reduce((sum, region) => sum + regionArea(region), 0) + regionArea(water)
      expect(at(year).reduce((sum, area) => sum + regionArea(area), 0)).toBeCloseTo(expectedArea, 3)
    }
    expect(at(2025)).toEqual(finalCover)
    for (const area of finalCover) expect(history.some(version => version.from === 2025 && version.value.id === area.id)).toBe(true)
    expect(history.every(version => version.to === undefined || version.to > version.from)).toBe(true)
    expect(JSON.stringify(input)).toBe(immutable)
    expect(buildContinuousCoverHistory(input)).toEqual(history)
  })
})
