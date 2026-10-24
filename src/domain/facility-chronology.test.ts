import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { DEFAULT_CONFIG, generateCity } from './generator'
import type { TerrainModel } from './terrain'
import type { UrbanGrowthInput } from './urban-growth'
import { erodeTerrain } from './hydrology'
import { sliceCityAtYear } from './timeline'
import { corridorPolygon, distanceToSegment, pointInRegion, polygonArea, polygonOverlapsRegion, polygonsOverlap, rectangle, regionArea } from './geometry'

const fixture = vi.hoisted(() => ({ cut: null as null | { x: number; y: number }, cutYear: 1955, parks: false, woodedHill: false, lateStreet: false }))
afterEach(() => { fixture.cut = null; fixture.cutYear = 1955; fixture.parks = false; fixture.woodedHill = false; fixture.lateStreet = false })

vi.mock('./urban-growth', async importOriginal => {
  const original = await importOriginal<typeof import('./urban-growth')>()
  return { ...original, simulateUrbanGrowth: (input: UrbanGrowthInput) => {
    if (fixture.parks) for (const year of [1955, 1960]) if (year <= (input.untilYear ?? 2025)) input.onCivicPopulation?.(year, [500, 1150, 2300].map(y => ({ point: { x: 1100, y }, households: 500 })))
    const roads = [
      ...(!fixture.lateStreet || (input.untilYear ?? 2025) >= 1975 ? [{ id: 'old-street', points: [{ x: 1100, y: 100 }, { x: 1100, y: 2900 }], kind: 'arterial' as const, width: 10, role: 'highway' as const, builtYear: fixture.lateStreet ? 1975 : 1650, reason: 'inherited street', phase: 'historic', constructionCost: 1 }] : []),
      ...((input.untilYear ?? 2025) >= (fixture.lateStreet ? 1975 : 1900) ? [{ id: 'future-avenue', points: [{ x: 1600, y: 100 }, { x: 1600, y: 2900 }], kind: 'arterial' as const, width: 10, role: 'highway' as const, builtYear: fixture.lateStreet ? 1975 : 1900, reason: 'later street', phase: 'railway', constructionCost: 1 }] : []),
      ...((input.untilYear ?? 2025) >= fixture.cutYear && fixture.cut ? [{ id: 'school-acquisition-road', points: [{ x: 1100, y: fixture.cut.y - 180 }, { x: fixture.cut.x, y: fixture.cut.y - 80 }, { x: fixture.cut.x, y: fixture.cut.y + 80 }, { x: 1100, y: fixture.cut.y + 180 }], kind: 'local' as const, width: 8, role: 'collector' as const, builtYear: fixture.cutYear, reason: 'later public street', phase: 'suburban', constructionCost: 1 }] : []),
    ]
    return { roads, roadHistory: roads.map(road => ({ from: road.builtYear, value: { ...road, points: road.points.map(point => ({ ...point })) } })), centers: [{ point: { x: 1100, y: 1500 }, kind: 'historic' as const, weight: 1, activeYear: 1650, catchment: 500 }], developmentCells: [], demandSchedule: [], growthLog: [], blocks: [],
    }
  } }
})

function flatSurvey(): TerrainModel {
  const raw = new Float32Array(16).fill(5)
  const hydrology: TerrainModel['hydrology'] = { ...erodeTerrain(raw, 4, 4, 2000, { passes: 0 }),
    extent: 6000, columns: 4, rows: 4, resolution: 2000, seed: 1, ocean: new Uint8Array(16),
    cropOrigin: { x: 0, y: 0 }, frame: { worldAnchor: { x: 0, y: 0 }, localAnchor: { x: 0, y: 0 }, angle: 0, mirrored: false },
    localResolution: 2000, localColumns: 4, localRows: 4, localDEM: raw, channelEvolution: [], oxbows: [], depressionLakes: [] }
  return { areas: fixture.woodedHill ? [{ id: 'forest-hill', kind: 'forest', polygon: rectangle(800, 100, 1600, 2800), name: '丘の林' }] : [], elevation: p => 5 + (fixture.woodedHill ? (p.x - 1100) * .06 : 0), slope: () => fixture.woodedHill ? .06 : 0, waterAt: () => false, cityOrigin: { x: 1800, y: 1500 }, landform: () => 'terrace', wetness: () => .2,
    terrainCost: () => 1, cultivable: () => false, bankDistance: () => Infinity, channelAt: () => null, rivers: [], bridgeSites: [], bridgeCandidates: [], hydrology }
}

describe('facility construction uses its own historical street survey', () => {
  it('keeps the early shrine and past frontage fixed when a future avenue and later school become available', { timeout: 60000 }, () => {
    // School precedes shrine in the UI selection deliberately: filtering the
    // selection at1850 used to change the shrine's target index at1900.
    const config = { ...DEFAULT_CONFIG, type: 'newtown' as const, density: 0, railway: false, facilities: ['school', 'shrine'] as const }
    const earlier = generateCity({ ...config, facilities: [...config.facilities], targetYear: 1850 }, undefined, undefined, flatSurvey)
    const later = generateCity({ ...config, facilities: [...config.facilities], targetYear: 1900 }, undefined, undefined, flatSurvey)
    const before = earlier.facilities.find(f => f.kind === 'shrine'), after = later.facilities.find(f => f.kind === 'shrine')
    expect(before).toBeDefined()
    expect(after).toEqual(before)
    expect(later.areas.find(a => a.id === 'facility-lot-shrine')).toEqual(earlier.areas.find(a => a.id === 'facility-lot-shrine'))
    const a = earlier.roads.find(r => r.id === 'facility-access-shrine')!, b = later.roads.find(r => r.id === 'facility-access-shrine')!
    expect(a.builtYear).toBe(1650)
    expect(b.builtYear).toBe(1650)
    for (const p of [...a.points, ...b.points]) {
      const other = a.points.includes(p) ? b : a
      expect(Math.min(...other.points.slice(1).map((q, i) => distanceToSegment(p, other.points[i]!, q)))).toBeLessThan(.001)
    }
    expect(Math.abs(a.points[0]!.x - 1100)).toBeLessThan(.001)
    expect(earlier.facilities.some(f => f.kind === 'school')).toBe(false)
    expect(later.buildings.find(b => b.id === 'facility-building-school')?.builtYear).toBe(1875)
    const prefix = new Map(earlier.buildings.map(building => [building.id, building]))
    // Occupancy can legitimately change by1900 when another street opens.
    // Compare the actual1850 versions, including occupancy, so this check
    // rejects future leakage without requiring residents never to move.
    const laterOldStock = sliceCityAtYear(later, 1850).buildings.filter(building => (building.builtYear ?? 1700) <= 1850)
    expect(laterOldStock.length).toBeGreaterThan(0)
    for (const building of laterOldStock) expect(building).toEqual(prefix.get(building.id))
    // Facility geometry is actually acquired, not a label-only correction.
    const campus = earlier.areas.find(area => area.id === 'facility-lot-shrine')!.polygon
    expect(polygonArea(campus)).toBeGreaterThan(4500)
    const shrine = earlier.buildings.find(building => building.id === 'facility-building-shrine')!
    expect(shrine.builtYear).toBe(1650)
    expect(polygonOverlapsRegion(shrine.polygon, { polygon: campus })).toBe(true)
    expect(earlier.buildings.filter(building => building.id !== shrine.id).every(building => !polygonsOverlap(building.polygon, campus))).toBe(true)
  })

  it('records later transport acquisition and a contemporaneous replacement without rewriting the old school', { timeout: 60000 }, () => {
    const config = { ...DEFAULT_CONFIG, type: 'newtown' as const, density: 0, railway: false, facilities: ['school'] as const }
    const earlier = generateCity({ ...config, facilities: [...config.facilities], targetYear: 1900 }, undefined, undefined, flatSurvey)
    const oldSchool = earlier.buildings.find(building => building.id === 'facility-building-school')!
    fixture.cut = earlier.facilities.find(facility => facility.kind === 'school')!.point
    const later = generateCity({ ...config, facilities: [...config.facilities], targetYear: 1960 }, undefined, undefined, flatSurvey)
    const replacement = later.buildings.find(building => building.id.startsWith('facility-building-school-relocation-'))
    expect(replacement).toBeDefined()
    expect(replacement!.builtYear).toBe(1955)
    expect(later.buildings.some(building => building.id === oldSchool.id)).toBe(false)
    expect(later.events!.some(event => event.kind === 'acquisition' && event.entityId === oldSchool.id && event.year === 1955 && event.reason.includes('school-acquisition-road'))).toBe(true)
    expect(later.events!.some(event => event.kind === 'construction' && event.entityId === replacement!.id && event.year === 1955)).toBe(true)
    for (const road of later.roads) for (let i = 1; i < road.points.length; i++) expect(polygonOverlapsRegion(replacement!.polygon, { polygon: corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2) })).toBe(false)
    const again = generateCity({ ...config, facilities: [...config.facilities], targetYear: 1900 }, undefined, undefined, flatSurvey)
    expect(again.buildings).toEqual(earlier.buildings)
    expect(again.facilities).toEqual(earlier.facilities)
    const currentIds = new Set(later.buildings.map(building => building.id))
    for (const building of earlier.buildings.filter(building => !currentIds.has(building.id))) expect(later.events!.some(event => event.kind === 'acquisition' && event.entityId === building.id && event.year > 1900)).toBe(true)
  })

  it('places park rounds from their dated population snapshots and preserves the1955park stock in1960', { timeout: 60000 }, () => {
    fixture.parks = true
    const config = { ...DEFAULT_CONFIG, type: 'newtown' as const, railway: false, facilities: ['police', 'park'] as const }
    const earlier = generateCity({ ...config, facilities: [...config.facilities], targetYear: 1955 }, undefined, undefined, flatSurvey)
    const later = generateCity({ ...config, facilities: [...config.facilities], targetYear: 1960 }, undefined, undefined, flatSurvey)
    const parks = earlier.facilities.filter(facility => facility.id.startsWith('neighbourhood-park-'))
    expect(parks.length).toBeGreaterThan(0)
    for (const park of parks) {
      expect(later.facilities.find(facility => facility.id === park.id)).toEqual(park)
      const before = earlier.roads.find(road => road.id === `${park.id}-access`)!
      expect(before.builtYear).toBe(1955)
      expect(later.roads.find(road => road.id === before.id)?.points).toEqual(before.points)
    }
    const police = later.buildings.find(building => building.id.startsWith('facility-building-police'))!
    for (const road of later.roads.filter(road => road.id.startsWith('neighbourhood-park-'))) for (let i = 1; i < road.points.length; i++) expect(polygonOverlapsRegion(police.polygon, { polygon: corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2) })).toBe(false)
  })

  it('places an explicitly requested university and a wooded park without clearing their entire hillside', { timeout: 30000 }, () => {
    fixture.woodedHill = true
    const map = generateCity({ ...DEFAULT_CONFIG, type: 'newtown', density: 0, railway: false, forest: 100, targetYear: 2025, facilities: ['university', 'park'] }, undefined, undefined, flatSurvey)
    expect(map.facilities.some(f => f.kind === 'university')).toBe(true)
    expect(map.facilities.some(f => f.kind === 'park')).toBe(true)
    const university = map.buildings.filter(building => building.id.startsWith('facility-building-university'))
    expect(university.length).toBeGreaterThanOrEqual(3)
    expect(map.roads.filter(road => road.id.startsWith('facility-access-university-internal-')).length).toBe(university.length + 1)
    const forest = map.areas.filter(area => area.kind === 'forest')
    expect(forest.reduce((sum, area) => sum + regionArea(area), 0)).toBeGreaterThan(1600 * 2800 * .97)
    for (const building of university) expect(forest.every(area => !polygonOverlapsRegion(building.polygon, area))).toBe(true)
    const oldForest = map.timeline!.areas.filter(version => version.value.kind === 'forest' && version.from <= 1950 && (version.to === undefined || 1950 < version.to))
    expect(oldForest.some(version => pointInRegion(university[0]!.polygon[0]!, version.value))).toBe(true)
    expect(map.timeline!.buildings.filter(version => version.value.id.startsWith('facility-building-university')).every(version => version.from >= 1965)).toBe(true)
    if (process.env.CIVIC_CAPTURE_PATH) writeFileSync(process.env.CIVIC_CAPTURE_PATH, JSON.stringify(map))
  })

  it('retries a failed university survey when a later street provides real access', { timeout: 30000 }, () => {
    fixture.woodedHill = true; fixture.lateStreet = true
    const map = generateCity({ ...DEFAULT_CONFIG, type: 'newtown', density: 0, railway: false, targetYear: 2025, facilities: ['university'] }, undefined, undefined, flatSurvey)
    const university = map.buildings.filter(building => building.id.startsWith('facility-building-university'))
    expect(university.length).toBeGreaterThanOrEqual(3)
    expect(university.every(building => building.builtYear === 1975)).toBe(true)
    expect(map.unplacedFacilities).toEqual([])
  })

  it('does not create a university when it was not requested', { timeout: 30000 }, () => {
    const map = generateCity({ ...DEFAULT_CONFIG, type: 'newtown', density: 0, railway: false, targetYear: 2025, facilities: [] }, undefined, undefined, flatSurvey)
    expect(map.facilities.some(facility => facility.kind === 'university')).toBe(false)
    expect(map.buildings.some(building => building.id.startsWith('facility-building-university'))).toBe(false)
  })

  it('archives every acquired university building and internal path before relocating the campus', { timeout: 30000 }, () => {
    fixture.woodedHill = true
    const config = { ...DEFAULT_CONFIG, type: 'newtown' as const, density: 0, railway: false, facilities: ['university' as const] }
    const before = generateCity({ ...config, targetYear: 1975 }, undefined, undefined, flatSurvey)
    fixture.cut = before.facilities.find(f => f.kind === 'university')!.point; fixture.cutYear = 1985
    const after = generateCity({ ...config, targetYear: 2025 }, undefined, undefined, flatSurvey)
    expect(after.buildings.filter(building => building.id.startsWith('facility-building-university-relocation-')).length).toBeGreaterThanOrEqual(3)
    for (const building of before.buildings.filter(building => building.id.startsWith('facility-building-university'))) {
      expect(after.buildings.some(current => current.id === building.id)).toBe(false)
      expect(after.timeline!.buildings.some(version => version.value.id === building.id && version.to === 1985)).toBe(true)
      expect(after.events!.some(event => event.entityId === building.id && event.kind === 'acquisition' && event.year === 1985)).toBe(true)
    }
    for (const road of before.roads.filter(road => road.id.startsWith('facility-access-university'))) {
      expect(after.roads.some(current => current.id === road.id)).toBe(false)
      expect(after.timeline!.roads.some(version => version.value.id === road.id && version.to === 1985)).toBe(true)
    }
  })
})
