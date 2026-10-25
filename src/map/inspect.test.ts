import { expect, it } from 'vitest'
import type { CityMap } from '../domain/types'
import { createMapInspector, featureHistory, featureSummary } from './inspect'
import { createCityTimeline, sliceCityAtYear } from '../domain/timeline'

const map = {
  width: 100, height: 100, description: '履歴と地物選択の検証', areas: [], stations: [],
  config: { name: '検証市', seed: 'inspect', type: 'castle', terrain: 'river', density: 50, forest: 0, railway: false, stations: 1, arterial: false, facilities: [] },
  buildings: [{ id: 'building-p-2020', parcelId: 'p', polygon: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }], kind: 'residential', height: 3, builtYear: 2020 }],
  roads: [{ id: 'road', points: [{ x: 0, y: 50 }, { x: 100, y: 50 }], width: 6, kind: 'local', builtYear: 1800 }], railways: [], facilities: [],
  districts: [{ id: 'town', name: '川端町', regions: [{ polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], holes: [[{ x: 70, y: 70 }, { x: 90, y: 70 }, { x: 90, y: 90 }, { x: 70, y: 90 }]] }], point: { x: 40, y: 40 } }],
  parcels: [{ id: 'p', polygon: [], entrance: { x: 20, y: 35 }, roadId: 'road', createdYear: 1800, use: 'residential' }],
  events: [
    { id: 'a', entityId: 'building-p', year: 1850, kind: 'construction', reason: '最初の家' },
    { id: 'b', entityId: 'building-p', year: 2020, kind: 'acquisition', reason: '建替え' },
    { id: 'c', entityId: 'building-p-2020', year: 2020, kind: 'construction', reason: '新しい共同住宅' },
    { id: 'other', entityId: 'building-p-other', year: 1900, kind: 'construction', reason: '無関係な家' },
  ],
} as CityMap
const layers = { buildings: true, facilities: true, roads: true, railway: true, terrain: true, labels: true }
it('selects actual building/road footprints and respects district holes and hidden layers', () => {
  const pick = createMapInspector(map)
  expect(pick({ x: 20, y: 20 }, 1, layers)?.type).toBe('building')
  expect(pick({ x: 50, y: 52 }, 1, layers)?.item.id).toBe('road')
  expect(pick({ x: 60, y: 60 }, 1, layers)?.item.id).toBe('town')
  expect(pick({ x: 80, y: 80 }, 1, layers)).toBeUndefined()
  expect(pick({ x: 20, y: 20 }, 1, { ...layers, buildings: false, labels: false })).toBeUndefined()
})
it('shows recorded parcel rebuild history without inventing or including unrelated events', () => {
  const history = featureHistory(map, { type: 'building', item: map.buildings[0]! })
  expect(history.map(e => [e.year, e.reason])).toEqual([[1850, '最初の家'], [2020, '建替え'], [2020, '新しい共同住宅']])
  expect(featureHistory(map, { type: 'area', item: { id: 'forest', kind: 'forest', polygon: [] } })).toEqual([])
})
it('finds replaced layout buildings by their saved parcel identity and hides future work in past views', () => {
  const parcelId = 'layout-parcel-14'
  const first = { ...map.buildings[0]!, id: 'layout-building-layout-parcel-14-1800-0', parcelId, builtYear: 1800 }
  const second = { ...first, id: 'layout-building-layout-parcel-14-1880-1', builtYear: 1880 }
  const current = { ...first, id: 'layout-building-layout-parcel-14-1970-2', builtYear: 1970 }
  const other = { ...first, id: 'layout-building-layout-parcel-14-1850-other', parcelId: 'other-parcel', builtYear: 1850 }
  const layout: CityMap = { ...map, buildings: [current], parcels: [{ ...map.parcels![0]!, id: parcelId }], year: 2025, events: [
    { id: 'a-first', entityId: first.id, year: 1800, kind: 'construction', reason: '最初の建物' },
    { id: 'b-retire', entityId: first.id, year: 1880, kind: 'acquisition', reason: '初代を解体' },
    { id: 'c-second', entityId: second.id, year: 1880, kind: 'construction', reason: '二代目を建築' },
    { id: 'd-retire', entityId: second.id, year: 1970, kind: 'acquisition', reason: '二代目を解体' },
    { id: 'e-current', entityId: current.id, year: 1970, kind: 'construction', reason: '現存建物を建築' },
    { id: 'other', entityId: other.id, year: 1850, kind: 'construction', reason: '似たIDの別敷地' },
  ] }
  layout.timeline = createCityTimeline(layout, { buildings: [
    { from: 1800, to: 1880, value: first }, { from: 1880, to: 1970, value: second }, { from: 1970, value: current }, { from: 1850, value: other },
  ] })
  const savedHistory = JSON.stringify(layout.timeline)
  expect(featureHistory(layout, { type: 'building', item: current }).map(event => event.id)).toEqual(['a-first', 'b-retire', 'c-second', 'd-retire', 'e-current'])
  const past = sliceCityAtYear(layout, 1850)
  expect(featureHistory(past, { type: 'building', item: past.buildings.find(building => building.parcelId === parcelId)! }).map(event => event.id)).toEqual(['a-first'])
  expect(JSON.stringify(layout.timeline)).toBe(savedHistory)
})
it('includes dated civic relocation history when its label is clicked', () => {
  const civic: CityMap = { ...map, events: [
    { id: 'school-open', entityId: 'facility-building-school', year: 1875, kind: 'construction', reason: '学校を建設' },
    { id: 'school-acquired', entityId: 'facility-building-school', year: 1955, kind: 'acquisition', reason: '道路用地取得' },
    { id: 'school-moved', entityId: 'facility-building-school-relocation-1955-1', year: 1955, kind: 'construction', reason: '学校を移転再建' },
    { id: 'other', entityId: 'facility-building-police', year: 1880, kind: 'construction', reason: '別施設' },
  ] }
  const history = featureHistory(civic, { type: 'facility', item: { id: 'facility-school', kind: 'school', name: '学校', point: { x: 40, y: 40 } } })
  expect(history.map(e => e.id)).toEqual(['school-open', 'school-acquired', 'school-moved'])
})
it('distinguishes inherited routes from their actual later construction works', () => {
  const road = { ...map.roads[0]!, builtYear: 1650, modifiedYear: 1985, reason: '交通量増加による6mへの拡幅' }
  expect(featureSummary({ type: 'road', item: road })).toBe('幅員6 m · 1650年成立 · 1985年改良')
  const events = featureHistory({ ...map, events: [] }, { type: 'road', item: road })
  expect(events.map(event => [event.year, event.reason])).toEqual([[1650, '道の成立'], [1985, '交通量増加による6mへの拡幅']])
})
