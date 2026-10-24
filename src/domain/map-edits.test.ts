import { describe, expect, it } from 'vitest'
import { applyMapEdits, editingError, getMapEditIssues, MAX_MAP_EDITS, validateMapEdits } from './map-edits'
import type { MapEdit } from './map-edits'
import { createCityTimeline, sliceCityAtYear } from './timeline'
import { parseProject, portableProject } from './project'
import { pointInRegion, rectangle, regionArea } from './geometry'
import type { CityMap } from './types'
import type { Project } from './project'

function world(): CityMap {
  const map: CityMap = { width: 1200, height: 1000, config: { name: '編集市', seed: 'edit', type: 'post', terrain: 'plain', density: 60, forest: 0, railway: true, stations: 1, arterial: true, facilities: [], targetYear: 2025 }, year: 2025, description: '', roads: [{ id: 'street', points: [{ x: 0, y: 600 }, { x: 700, y: 600 }], kind: 'local', width: 6, builtYear: 1800 }], buildings: [{ id: 'old-house', polygon: rectangle(100, 100, 20, 20), height: 2, kind: 'residential', builtYear: 1800 }, { id: 'future-house', polygon: rectangle(300, 300, 20, 20), height: 2, kind: 'residential', builtYear: 2000 }], areas: [{ id: 'cover', kind: 'field', landUse: 'meadow', polygon: rectangle(0, 0, 1200, 1000) }, { id: 'river', kind: 'water', polygon: rectangle(900, 0, 100, 1000), name: '編集川' }], facilities: [], districts: [{ id: 'town', name: '本町', point: { x: 300, y: 400 }, foundedYear: 1800 }], railways: [{ id: 'rail', name: '地上線', points: [{ x: 800, y: 0 }, { x: 800, y: 1000 }], builtYear: 1900 }], stations: [] }
  map.timeline = createCityTimeline(map)
  return map
}
const house = (id = 'house-edit', year = 1900, x = 300): Extract<MapEdit, { operation: 'upsert'; targetKind: 'building' }> => ({ id, year, operation: 'upsert', targetKind: 'building', value: { id: 'manual-house', kind: 'residential', height: 4, polygon: rectangle(x, 300, 25, 25), name: '手動住宅' } })
const road = (bridge = false): MapEdit => ({ id: 'road-edit', year: 2000, operation: 'upsert', targetKind: 'road', value: { id: 'manual-road', points: [{ x: 850, y: 700 }, { x: 1100, y: 700 }], kind: 'local', width: 5, bridge } })

describe('dated manual map overlays', () => {
  it('keeps a commitment from its selected year and acquires later generated buildings only in the visible frame', () => {
    const base = world(), before = JSON.stringify(base), edit = house(), past = sliceCityAtYear(base, 1900)
    expect(editingError(past, edit)).toBeNull()
    expect(applyMapEdits(sliceCityAtYear(base, 1899), [edit]).buildings.some(b => b.id === 'manual-house')).toBe(false)
    expect(applyMapEdits(past, [edit]).buildings.map(b => b.id)).toEqual(['old-house', 'manual-house'])
    const current = applyMapEdits(base, [edit])
    expect(current.buildings.map(b => b.id)).toEqual(['old-house', 'manual-house'])
    expect(current.timeline).toBe(base.timeline)
    expect(base.buildings.some(b => b.id === 'future-house')).toBe(true)
    expect(JSON.stringify(base)).toBe(before)
    expect(applyMapEdits(base, [])).toBe(base)
  })
  it('replaces a moved entity without phantom acquisition at its old footprint, and undo restores original stock', () => {
    const base = world(), first = house(), moved = house('move-edit', 2010, 400)
    const current = applyMapEdits(base, [first, moved])
    expect(current.buildings.filter(b => b.id === 'manual-house')).toHaveLength(1)
    expect(current.buildings.find(b => b.id === 'manual-house')!.polygon[0]!.x).toBe(400)
    expect(current.buildings.some(b => b.id === 'future-house')).toBe(true)
    const remove: MapEdit = { id: 'delete-edit', year: 2020, operation: 'delete', targetKind: 'building', targetId: 'manual-house' }
    expect(applyMapEdits(base, [first, moved, remove]).buildings).toEqual(base.buildings)
    expect(applyMapEdits(base, [first]).buildings.some(b => b.id === 'future-house')).toBe(false)
  })
  it('resolves chronology before append order and keeps same-year edits and Undo deterministic', () => {
    const base = world(), early = house('early', 1900, 400), late = house('late', 2020, 500), sameYear = house('same-year', 2020, 600)
    expect(applyMapEdits(base, [late, early]).buildings.find(b => b.id === 'manual-house')!.polygon[0]!.x).toBe(500)
    expect(applyMapEdits(sliceCityAtYear(base, 1950), [late, early]).buildings.find(b => b.id === 'manual-house')!.polygon[0]!.x).toBe(400)
    expect(applyMapEdits(base, [late, early, sameYear]).buildings.find(b => b.id === 'manual-house')!.polygon[0]!.x).toBe(600)
    const rename = (id: string, year: number, name: string): MapEdit => ({ id, year, operation: 'rename', targetKind: 'district', targetId: 'town', name })
    expect(applyMapEdits(base, [rename('late-name', 2020, '新本町'), rename('early-name', 1900, '旧本町')]).districts[0]!.name).toBe('新本町')
    const remove: MapEdit = { id: 'late-remove', year: 2020, operation: 'delete', targetKind: 'building', targetId: 'manual-house' }
    expect(applyMapEdits(base, [remove, early]).buildings.some(b => b.id === 'manual-house')).toBe(false)
    expect(applyMapEdits(base, [early]).buildings.some(b => b.id === 'manual-house')).toBe(true)
  })
  it('hides commitments conflicting with later roads, surface rails or station sites without mutating the archive', () => {
    const addInfrastructure: ((map: CityMap) => void)[] = [
      map => map.roads.push({ id: 'future-road', kind: 'local', width: 8, builtYear: 1950, points: [{ x: 250, y: 312 }, { x: 360, y: 312 }] }),
      map => map.railways.push({ id: 'future-rail', name: '新線', builtYear: 1950, points: [{ x: 312, y: 250 }, { x: 312, y: 360 }] }),
      map => map.stations.push({ id: 'future-station', name: '新駅', point: { x: 800, y: 310 }, builtYear: 1950, railwayId: 'rail', buildingPolygon: rectangle(310, 310, 20, 20) }),
    ]
    for (const add of addInfrastructure) {
      const base = world(); add(base); base.timeline = createCityTimeline(base)
      const edit = house(), before = JSON.stringify(base), past = applyMapEdits(sliceCityAtYear(base, 1900), [edit]), now = applyMapEdits(base, [edit])
      expect(past.buildings.some(b => b.id === 'manual-house')).toBe(true)
      expect(getMapEditIssues(past)).toEqual([])
      expect(now.buildings.some(b => b.id === 'manual-house')).toBe(false)
      expect(now.buildings.some(b => b.id === 'future-house')).toBe(true)
      expect(getMapEditIssues(now)).toEqual([{ id: edit.id, reason: expect.stringMatching(/道路|線路|駅舎/) }])
      expect(getMapEditIssues(base)).toEqual([])
      expect(JSON.stringify(base)).toBe(before)
    }
  })
  it('replays imported placements through building, station, water and at-grade crossing checks', () => {
    const base = world(), overOldHouse = { ...house(), value: { ...house().value, polygon: rectangle(105, 105, 20, 20) } }, importedRoad: MapEdit = { id: 'unsafe-import', year: 2000, operation: 'upsert', targetKind: 'road', value: { id: 'unsafe', kind: 'local', width: 5, points: [{ x: 750, y: 650 }, { x: 850, y: 650 }] } }
    for (const edit of [overOldHouse, importedRoad, road()]) {
      const result = applyMapEdits(base, [edit])
      expect(getMapEditIssues(result)).toEqual([{ id: edit.id, reason: expect.any(String) }])
      expect(result).not.toBe(base)
      expect(result.buildings).toBe(base.buildings); expect(result.roads).toBe(base.roads)
    }
    const stationWorld = { ...base, stations: [{ id: 'station', name: '駅', point: { x: 800, y: 500 }, buildingPolygon: rectangle(700, 700, 20, 20) }] }
    const throughStation: MapEdit = { ...importedRoad, value: { ...importedRoad.value, points: [{ x: 680, y: 710 }, { x: 750, y: 710 }] } }
    expect(getMapEditIssues(applyMapEdits(stationWorld, [throughStation]))[0]!.reason).toMatch(/駅舎/)
    const elevated = { id: 'flyover', kind: 'local' as const, width: 5, level: 1, points: [{ x: 750, y: 650 }, { x: 850, y: 650 }] }
    expect(getMapEditIssues(applyMapEdits({ ...base, roads: [...base.roads, elevated] }, [importedRoad]))[0]!.reason).toMatch(/地上線/)
    const inherited = { ...elevated, level: 0 }
    const redraw: MapEdit = { ...importedRoad, value: inherited }
    expect(editingError({ ...base, roads: [...base.roads, inherited] }, redraw)).toBeNull()
    expect(getMapEditIssues(applyMapEdits({ ...base, roads: [...base.roads, inherited] }, [redraw]))).toEqual([])
    expect(getMapEditIssues(applyMapEdits(base, [road(true)]))).toEqual([])
    expect(getMapEditIssues(applyMapEdits({ ...base, railways: base.railways.map(r => ({ ...r, mode: 'subway' })) }, [importedRoad]))).toEqual([])
    const parallel: MapEdit = { ...importedRoad, value: { ...importedRoad.value, width: 12, points: [{ x: 794, y: 200 }, { x: 794, y: 400 }] } }
    expect(getMapEditIssues(applyMapEdits(base, [parallel]))[0]!.reason).toMatch(/線路/)
    const forecourt: MapEdit = { ...importedRoad, value: { ...importedRoad.value, points: [{ x: 750, y: 400 }, { x: 800, y: 400 }] } }
    expect(getMapEditIssues(applyMapEdits(base, [forecourt]))).toEqual([])
  })
  it('removes a route and only its affiliated stations, restoring them with Undo and past dates', () => {
    const base = world(); base.railways.push({ id: 'other', name: '別線', builtYear: 1900, points: [{ x: 795, y: 0 }, { x: 795, y: 1000 }] })
    base.stations = [
      { id: 'owned', name: '所属駅', point: { x: 800, y: 200 }, railwayId: 'rail', buildingPolygon: rectangle(820, 200, 20, 20) },
      { id: 'legacy', name: '旧駅', point: { x: 802, y: 400 } },
      { id: 'other-owned', name: '別線駅', point: { x: 800, y: 600 }, railwayId: 'other' },
      { id: 'other-legacy', name: '別線旧駅', point: { x: 795, y: 800 } },
      { id: 'ambiguous', name: '共同駅', point: { x: 797.5, y: 900 } },
      { id: 'subway-station', name: '地下駅', point: { x: 800, y: 300 }, mode: 'subway' },
      { id: 'far-away', name: '遠方駅', point: { x: 770, y: 400 } },
    ]
    base.timeline = createCityTimeline(base)
    const remove: MapEdit = { id: 'delete-route', year: 2000, operation: 'delete', targetKind: 'railway', targetId: 'rail' }, result = applyMapEdits(base, [remove])
    expect(result.railways.map(r => r.id)).toEqual(['other'])
    expect(result.stations.map(s => s.id)).toEqual(['other-owned', 'other-legacy', 'ambiguous', 'subway-station', 'far-away'])
    expect(applyMapEdits(sliceCityAtYear(base, 1999), [remove]).stations).toEqual(base.stations)
    expect(applyMapEdits(base, []).stations).toEqual(base.stations)
    expect(base.timeline.stations).toHaveLength(7)
    const onDeletedRoute = { ...house(), value: { ...house().value, polygon: rectangle(795, 100, 20, 20) } }
    const onlyRoute = { ...base, railways: base.railways.filter(r => r.id === 'rail') }
    expect(getMapEditIssues(applyMapEdits(onlyRoute, [onDeletedRoute, remove]))).toEqual([])
  })
  it('paints land by subtracting prior cover and keeps generated/manual building masks', () => {
    const base = world(), paint: MapEdit = { id: 'paint', year: 1900, operation: 'upsert', targetKind: 'area', value: { id: 'manual-forest', kind: 'forest', polygon: rectangle(200, 200, 300, 300) } }, build = house('new-pad', 1950, 250)
    expect(editingError(sliceCityAtYear(base, 1900), paint)).toBeNull()
    expect(editingError(base, paint)).toBeNull()
    const result = applyMapEdits(base, [paint, build])
    expect(result.areas.some(a => a.kind === 'forest' && pointInRegion({ x: 220, y: 220 }, a))).toBe(true)
    expect(result.areas.some(a => a.kind === 'forest' && pointInRegion({ x: 310, y: 310 }, a))).toBe(false)
    expect(result.areas.some(a => a.kind !== 'water' && pointInRegion({ x: 260, y: 310 }, a))).toBe(false)
    expect(result.areas.some(a => a.id === 'cover' && pointInRegion({ x: 220, y: 220 }, a))).toBe(false)
    expect(base.areas).toHaveLength(2)
    const moved: MapEdit = { ...paint, id: 'moved-paint', year: 2010, value: { ...paint.value, polygon: rectangle(500, 200, 200, 200) } }
    const shifted = applyMapEdits(base, [paint, moved])
    expect(shifted.areas.some(a => a.id === 'cover' && pointInRegion({ x: 220, y: 220 }, a))).toBe(true)
    expect(shifted.areas.filter(a => a.kind !== 'water').reduce((sum, a) => sum + regionArea(a), 0)).toBeCloseTo(1200000)
  })
  it('deletes/renames identities without rewriting historical versions and protects water geometry', () => {
    const base = world(), rename: MapEdit = { id: 'name', year: 1930, operation: 'rename', targetKind: 'district', targetId: 'town', name: '桜町' }, remove: MapEdit = { id: 'remove', year: 1950, operation: 'delete', targetKind: 'building', targetId: 'old-house' }
    const result = applyMapEdits(base, [rename, remove])
    expect(result.districts[0]!.name).toBe('桜町'); expect(result.districts[0]!.namingSource).toBe('edited')
    expect(result.buildings.some(b => b.id === 'old-house')).toBe(false)
    expect(sliceCityAtYear(base, 1900).districts[0]!.name).toBe('本町')
    const deleteRiver: MapEdit = { id: 'remove-river', year: 2000, operation: 'delete', targetKind: 'area', targetId: 'river' }
    expect(editingError(base, deleteRiver)).toMatch(/水域/)
    expect(applyMapEdits(base, [deleteRiver]).areas.find(a => a.id === 'river')).toEqual(base.areas[1])
  })
  it('renames a painted area without moving its geometry above a later paint operation', () => {
    const a: MapEdit = { id: 'a', year: 1900, operation: 'upsert', targetKind: 'area', value: { id: 'a-forest', kind: 'forest', polygon: rectangle(500, 20, 100, 100) } }, b: MapEdit = { id: 'b', year: 1910, operation: 'upsert', targetKind: 'area', value: { id: 'b-park', kind: 'park', polygon: rectangle(550, 20, 100, 100) } }, rename: MapEdit = { id: 'rename-a', year: 1920, operation: 'rename', targetKind: 'area', targetId: 'a-forest', name: '北の森' }
    const result = applyMapEdits(world(), [a, b, rename])
    expect(result.areas.some(area => area.kind === 'park' && pointInRegion({ x: 575, y: 50 }, area))).toBe(true)
    expect(result.areas.some(area => area.name === '北の森' && pointInRegion({ x: 525, y: 50 }, area))).toBe(true)
    expect(applyMapEdits(world(), [road()]).roads.some(r => r.id === 'manual-road')).toBe(false)
  })
  it('keeps surface roads, tracks and station buildings clear when painting land around them', () => {
    const base = world(); base.stations.push({ id: 'station', name: '駅', point: { x: 800, y: 500 }, buildingPolygon: rectangle(770, 470, 20, 20) })
    const edit: MapEdit = { id: 'paint-transport', year: 2000, operation: 'upsert', targetKind: 'area', value: { id: 'trees', kind: 'forest', polygon: rectangle(650, 400, 200, 300) } }
    expect(editingError(base, edit)).toBeNull()
    const areas = applyMapEdits(base, [edit]).areas.filter(area => area.kind === 'forest')
    for (const p of [{ x: 680, y: 600 }, { x: 800, y: 550 }, { x: 780, y: 480 }]) expect(areas.some(area => pointInRegion(p, area))).toBe(false)
    expect(areas.some(area => pointInRegion({ x: 720, y: 500 }, area))).toBe(true)
  })
  it('checks real water/building/railway footprints and requires explicit river bridges and inherited level crossings', () => {
    const base = world()
    expect(editingError(base, house())).toMatch(/建物/)
    expect(editingError(base, { ...house(), value: { ...house().value, polygon: rectangle(905, 200, 20, 20) } } as MapEdit)).toMatch(/水域/)
    expect(editingError(base, road())).toMatch(/橋/)
    expect(editingError(base, road(true))).toBeNull()
    const crossing: MapEdit = { id: 'crossing', year: 2000, operation: 'upsert', targetKind: 'road', value: { id: 'new-crossing', points: [{ x: 750, y: 650 }, { x: 850, y: 650 }], width: 5, kind: 'local' } }
    expect(editingError(base, crossing)).toMatch(/地上線/)
    expect(editingError({ ...base, railways: base.railways.map(r => ({ ...r, mode: 'subway' })) }, crossing)).toBeNull()
    const inherited = { id: 'old-crossing', kind: 'local' as const, width: 5, points: [{ x: 700, y: 650 }, { x: 900, y: 650 }] }
    expect(editingError({ ...base, roads: [...base.roads, inherited] }, crossing)).toBeNull()
  })
  it('bounds unknown imported commands and refuses invalid coordinates, geometry, years and properties', () => {
    const valid = house(), normalize = (v: unknown) => validateMapEdits(v, 1200, 1000)
    for (const value of [null, [valid, valid], Array.from({ length: MAX_MAP_EDITS + 1 }, (_, i) => ({ ...valid, id: `e${i}` })), [{ ...valid, year: 2030 }], [{ ...valid, year: 1900.5 }], [{ ...valid, value: { ...valid.value, height: Infinity } }], [{ ...valid, value: { ...valid.value, polygon: rectangle(-1, 0, 20, 20) } }], [{ ...valid, value: { ...valid.value, polygon: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }, { x: 20, y: 10 }] } }], [{ ...valid, targetKind: 'area', value: { id: 'sea', kind: 'water', polygon: rectangle(0, 0, 50, 50) } }]]) expect(() => normalize(value)).toThrow()
    const output = normalize([{ ...valid, secret: 'strip', value: { ...valid.value, arbitrary: 'strip' } }])
    expect(output[0]).not.toHaveProperty('secret'); expect((output[0] as typeof valid).value).not.toHaveProperty('arbitrary')
  })
  it('roundtrips edits separately from the generated archive, including woodland and university metadata', () => {
    const base = world(); base.config.facilities = ['university']; base.areas.push({ id: 'sparse-trees', kind: 'field', landUse: 'woodland', polygon: rectangle(500, 20, 100, 100) }); base.timeline = createCityTimeline(base)
    const project: Project = { version: 2, config: base.config, snapshot: base, edits: [house()], annotations: [], style: 'standard', layers: { terrain: true, roads: true, buildings: true, railway: true, facilities: true, labels: true, grid: false } }
    const imported = parseProject(JSON.stringify(portableProject(project)))
    expect(imported.edits).toEqual(validateMapEdits(project.edits, base.width, base.height))
    expect(imported.snapshot!.buildings).toEqual(base.buildings)
    expect(imported.snapshot!.areas.find(a => a.id === 'sparse-trees')!.landUse).toBe('woodland')
    expect(applyMapEdits(imported.snapshot!, imported.edits!).buildings.some(b => b.id === 'manual-house')).toBe(true)
    expect(parseProject(JSON.stringify({ ...project, edits: undefined })).edits).toBeUndefined()
  })
  it('preserves documented building and road metadata through redraw validation and project roundtrip', () => {
    const base = world(), lodging = { ...house(), value: { ...house().value, use: 'lodging' as const, lodgingType: 'ryokan' as const, guestRooms: 72, parcelId: 'inn-parcel', occupancy: 'underused' as const, occupiedHouseholds: 0, height: 120 } }, gateway: MapEdit = { id: 'gateway-edit', year: 2000, operation: 'upsert', targetKind: 'road', value: { id: 'gateway', kind: 'arterial', points: [{ x: 0, y: 800 }, { x: 300, y: 800 }], width: 12, role: 'highway', boundaryContinuation: true, modifiedYear: 1990 } }
    const project: Project = { version: 2, config: base.config, snapshot: base, edits: [lodging, gateway], annotations: [], style: 'standard', layers: { terrain: true, roads: true, buildings: true, railway: true, facilities: true, labels: true, grid: false } }
    const edits = parseProject(JSON.stringify(portableProject(project))).edits!
    expect(edits[0]).toMatchObject(lodging)
    expect(edits[1]).toMatchObject(gateway)
    for (const invalid of [{ guestRooms: 0 }, { guestRooms: 10_001 }, { lodgingType: 'castle' }, { occupancy: 'destroyed' }, { occupiedHouseholds: -1 }]) expect(() => validateMapEdits([{ ...lodging, value: { ...lodging.value, ...invalid } }], 1200, 1000)).toThrow()
  })
})
