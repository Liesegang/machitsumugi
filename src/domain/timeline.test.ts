import { describe, expect, it } from 'vitest'
import { createCityTimeline, renameTimelineDistricts, sliceCityAtYear } from './timeline'
import { parseProject, portableProject } from './project'
import type { Project } from './project'
import type { CityMap } from './types'

const polygon = [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 }, { x: 20, y: 40 }]
function world(): CityMap {
  const map: CityMap = { width: 500, height: 500, config: { name: '記録町', seed: 'history', terrain: 'plain', type: 'post', density: 20, forest: 0, railway: true, stations: 1, arterial: true, facilities: [], targetYear: 2025 }, year: 2025, description: '', roads: [], buildings: [], areas: [], railways: [], stations: [], facilities: [], districts: [], events: [{ id: 'later', year: 2000, kind: 'construction', entityId: 'tower', reason: '建替え' }], growthLog: [{ phase: 'suburban', year: 2000, roadsAdded: 0, households: 240, unmetHouseholds: 5, constructionCost: 1234 }] }
  const road = { id: 'road', points: [{ x: 10, y: 50 }, { x: 490, y: 50 }], kind: 'local' as const, width: 4, builtYear: 1700 }
  map.timeline = createCityTimeline(map, {
    roads: [{ from: 1700, to: 1960, value: road }, { from: 1960, value: { ...road, width: 8, modifiedYear: 1960 } }],
    buildings: [{ from: 1800, to: 2000, value: { id: 'house', polygon, kind: 'residential', height: 2, builtYear: 1800 } }, { from: 2000, value: { id: 'tower', polygon, kind: 'residential', height: 8, builtYear: 2000 } }],
    buildingStates: [{ id: 'house', from: 1800, occupancy: 'occupied', occupiedHouseholds: 1 }, { id: 'house', from: 1990, occupancy: 'vacant', occupiedHouseholds: 0 }],
    districts: [{ from: 1800, value: { id: 'town', point: { x: 50, y: 50 }, name: '川向町' } }],
    facilities: [{ from: 1875, to: 1970, value: { id: 'school', point: { x: 100, y: 100 }, kind: 'school', name: '学校' } }, { from: 1970, value: { id: 'school', point: { x: 300, y: 300 }, kind: 'school', name: '学校' } }],
  })
  return sliceCityAtYear(map, 2025)
}
describe('saved historical materialization', () => {
  it('restores retired stock, carriageway width, civic locations and occupancy without changing the archive', () => {
    const map = world(), history = map.timeline, old = sliceCityAtYear(map, 1950), vacant = sliceCityAtYear(old, 1995), present = sliceCityAtYear(old, 2025)
    expect(old.buildings.map(b => [b.id, b.height, b.occupancy])).toEqual([['house', 2, 'occupied']])
    expect(old.roads[0]!.width).toBe(4)
    expect(old.facilities[0]!.point.x).toBe(100)
    expect(vacant.buildings[0]!.occupancy).toBe('vacant')
    expect(vacant.facilities[0]!.point.x).toBe(300)
    expect(present.buildings[0]!.id).toBe('tower')
    expect(present.roads[0]!.width).toBe(8)
    expect(old.events).toEqual([])
    expect(present.events).toEqual(map.events)
    expect(present.timeline).toBe(history)
  })
  it('saves geometry once and validates/restores every date after import', () => {
    const map = world(), project: Project = { version: 2, config: map.config, snapshot: map, annotations: [], layers: { terrain: true, roads: true, buildings: true, labels: true, facilities: true, railway: true, grid: false }, style: 'standard' }
    const portable = portableProject(project)
    expect(portable.snapshot!.buildings).toEqual([])
    const imported = parseProject(JSON.stringify(portable)).snapshot!
    expect(imported.timeline!.growthLog).toEqual(map.timeline!.growthLog)
    expect(sliceCityAtYear(imported, 1850).buildings[0]!.id).toBe('house')
    expect(sliceCityAtYear(imported, 2025).roads[0]!.modifiedYear).toBe(1960)
    const corrupted = structuredClone(portable)
    corrupted.snapshot!.timeline!.roads[0]!.to = 1961
    expect(() => parseProject(JSON.stringify(corrupted))).toThrow(/重複/)
  })
  it('carries an edited name to other years and rejects missing-history slicing', () => {
    const renamed = renameTimelineDistricts(world(), d => ({ ...d, name: '水辺町', namingSource: 'edited' }))
    expect(sliceCityAtYear(renamed, 1850).districts[0]!.name).toBe('水辺町')
    expect(() => sliceCityAtYear({ ...renamed, timeline: undefined }, 1900)).toThrow(/履歴/)
  })
})
