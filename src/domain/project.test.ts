import { describe, expect, it, vi, afterEach } from 'vitest'
import { LEGACY_STORAGE_KEY, loadProject, loadProjectArchive, MAX_PROJECT_JSON_LENGTH, parseProject, persistProject, persistProjectArchive, PROJECT_GEOMETRY_LIMITS, STORAGE_KEY, validateProject } from './project'
import type { Project } from './project'
import type { CityMap } from './types'

const sample = (): Project => ({
  version: 2,
  config: {
    name: '水杜市', seed: 'minato-2026', type: 'castle', terrain: 'river', density: 65, forest: 30,
    railway: true, stations: 3, arterial: true, facilities: ['school', 'hospital', 'park'],
  },
  annotations: [{ id: 'pin-1', point: { x: 100, y: 200 }, name: '探索地点', note: 'GMのメモ\n二行目', secret: true }],
  layers: { buildings: true, roads: true, railway: true, labels: true, facilities: true, terrain: true, grid: false },
  style: 'standard',
})

const geometry = (): CityMap => ({
  width: 4000, height: 3000, config: sample().config, description: '道路・敷地と都市の履歴', generatorVersion: '2.0.0', year: 1930,
  roads: [{ id: 'road-1', points: [{ x: 0, y: 50 }, { x: 100, y: 50 }], kind: 'local', width: 5, builtYear: 1790, role: 'lane', reason: '街道沿いの集落', bridge: false }],
  buildings: [{ id: 'house-1', polygon: [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 30 }, { x: 10, y: 30 }], kind: 'residential', height: 2, parcelId: 'parcel-1', builtYear: 1800 }],
  areas: [{ id: 'field-1', polygon: [{ x: 200, y: 10 }, { x: 300, y: 10 }, { x: 250, y: 100 }], kind: 'field', name: '北の畑' }],
  railways: [{ id: 'rail-1', points: [{ x: 1000, y: 0 }, { x: 1000, y: 3000 }], name: '水杜線', elevations: [20, 21], structures: [{ kind: 'bridge', from: { x: 1000, y: 1200 }, to: { x: 1000, y: 1400 }, maxHeight: 6, length: 200 }] }],
  stations: [{ id: 'station-1', point: { x: 1000, y: 1500 }, name: '水杜駅' }],
  facilities: [{ id: 'school-1', point: { x: 500, y: 600 }, kind: 'school', name: '第一小学校' }],
  districts: [{ id: 'district-1', point: { x: 2000, y: 1400 }, name: '本町' }],
  growthLog: [{ phase: 'oldtown', roadsAdded: 1, year: 1800, reason: '街道への接続' }],
  parcels: [{ id: 'parcel-1', polygon: [{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 50 }, { x: 5, y: 50 }], entrance: { x: 15, y: 50 }, roadId: 'road-1', createdYear: 1790, developedYear: 1800, use: 'residential' }],
  events: [{ id: 'event-1', year: 1800, kind: 'construction', entityId: 'house-1', reason: '空き地への入居' }],
  snapshots: [{ year: 1800, households: 1, capacity: 2, vacant: 1, unmet: 0, roads: 1, buildings: 1 }],
  blocks: [{ id: 'block-1', polygon: [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 100 }, { x: 10, y: 100 }] }],
})

const withSnapshot = (): Project => ({ ...sample(), snapshot: geometry() })

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('saved projects', () => {
  it('retains the same terrain, regional crop, lake water level and physical volume audit', () => {
    const project = withSnapshot(), map = project.snapshot!
    map.terrainSurface = { columns: 5, rows: 4, cellSize: 1000, elevations: Array.from({ length: 20 }, (_, i) => 40 + i) }
    map.regionalContext = { extent: 24000, surface: { columns: 4, rows: 4, cellSize: 8000, elevations: Array.from({ length: 16 }, (_, i) => i * 30) }, crop: [{ x: 9000, y: 9000 }, { x: 13000, y: 9000 }, { x: 13000, y: 12000 }, { x: 9000, y: 12000 }] }
    map.areas.push({ id: 'lake', kind: 'water', waterLevel: 45.5, polygon: [{ x: 2000, y: 2000 }, { x: 2050, y: 2000 }, { x: 2050, y: 2050 }, { x: 2000, y: 2050 }] })
    map.terrainSimulation = { resolution: 100, steps: 256, elapsedYears: 1024000, bedrockErodedVolume: 10000, storedSedimentVolume: 2500, exportedSedimentVolume: 7500, sedimentBalanceError: 1e-5, groundBalanceError: .01, localExcavationVolume: 100, localDepositionVolume: 40, localExportedVolume: 60, localBalanceError: 0 }
    map.unplacedFacilities = [{ kind: 'school', reason: '地盤と接道に適した用地を確保できませんでした。' }]
    expect(parseProject(JSON.stringify(project))).toEqual(project)
  })
  it('roundtrips Japanese names, multiline notes and secrets without DOM APIs', () => {
    expect(parseProject(JSON.stringify(sample()))).toEqual(sample())
  })

  it('reconstructs independent values and strips unknown imported properties', () => {
    const input = { ...sample(), extra: 'ignore' }
    const output = validateProject(input)
    expect(output).not.toHaveProperty('extra')
    expect(output.config).not.toBe(input.config)
    expect(output.annotations[0].point).not.toBe(input.annotations[0].point)
  })

  it.each([null, [], 'text', 1, {}, { version: 3 }])('rejects an invalid root or version: %j', (value) => {
    expect(() => validateProject(value)).toThrow()
  })

  it.each([
    { density: -1 }, { density: 101 }, { density: Number.NaN }, { forest: Infinity },
    { railway: 'true' }, { stations: 0 }, { stations: 6 }, { stations: 1.5 },
    { type: 'city' }, { terrain: 'ocean' }, { name: '' }, { seed: 'x'.repeat(129) },
    { facilities: ['park', 'park'] }, { facilities: ['unknown'] },
  ])('rejects malformed or out-of-range configuration: %j', (change) => {
    const data = sample()
    Object.assign(data.config, change)
    expect(() => validateProject(data)).toThrow()
  })

  it('rejects malformed layers, styles, annotations and duplicate IDs', () => {
    expect(() => validateProject({ ...sample(), layers: { buildings: true } })).toThrow('レイヤー')
    expect(() => validateProject({ ...sample(), style: 'satellite' })).toThrow('配色')
    const data = sample()
    data.annotations[0].point.x = Number.NaN
    expect(() => validateProject(data)).toThrow('横位置')
    data.annotations = [...sample().annotations, ...sample().annotations]
    expect(() => validateProject(data)).toThrow('重複')
    expect(() => validateProject({ ...sample(), annotations: 'pins' })).toThrow('メモ')
  })

  it('provides useful errors for invalid JSON and oversized files', () => {
    expect(() => parseProject('{')).toThrow('JSONを読み取れません')
    expect(() => parseProject(' '.repeat(MAX_PROJECT_JSON_LENGTH + 1))).toThrow('大きすぎます')
  })

  it('uses a versioned storage key and validates data on restore', () => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    })
    expect(loadProject()).toBeNull()
    expect(persistProject(sample())).toBe(true)
    expect(memory.has(STORAGE_KEY)).toBe(true)
    expect(loadProject()).toEqual(sample())
    memory.set(STORAGE_KEY, '{broken')
    expect(loadProject()).toBeNull()
  })

  it('survives storage permission and quota failures', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
    })
    expect(loadProject()).toBeNull()
    expect(persistProject(sample())).toBe(false)
  })

  it('migrates a v1 file without fabricating geometry or changing its pins', () => {
    const legacy = { ...sample(), version: 1 }
    const migrated = parseProject(JSON.stringify(legacy))
    expect(migrated).toEqual(sample())
    expect(migrated.snapshot).toBeUndefined()
  })

  it('restores the legacy storage key until a completed v2 project is saved', () => {
    const memory = new Map([[LEGACY_STORAGE_KEY, JSON.stringify({ ...sample(), version: 1 })]])
    vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) })
    expect(loadProject()).toEqual(sample())
    expect(persistProject(withSnapshot())).toBe(true)
    expect(loadProject()).toEqual(withSnapshot())
    expect(memory.has(LEGACY_STORAGE_KEY)).toBe(true)
    memory.set(STORAGE_KEY, '{broken')
    expect(loadProject()).toEqual(sample())
  })

  it('preserves complete geometry, historic dates, parcels and growth history byte for byte as values', () => {
    const input = withSnapshot()
    input.snapshot!.generatorVersion = 'future-engine-9.2'
    Object.assign(input.snapshot!.roads[0], { phase: 'oldtown', constructionCost: 12345.6 })
    Object.assign(input.snapshot!.growthLog![0], { households: 1300, unmetHouseholds: 300, constructionCost: 24680.1 })
    const restored = parseProject(JSON.stringify(input))
    expect(restored).toEqual(input)
    expect(restored.snapshot!.buildings[0].polygon).not.toBe(input.snapshot!.buildings[0].polygon)
    expect(restored.snapshot!.parcels![0].entrance).not.toBe(input.snapshot!.parcels![0].entrance)
  })

  it('restores historic snapshots without requiring modern railways or a minimum building count', () => {
    const input = withSnapshot()
    input.config.era = 'historic'; input.snapshot!.config.era = 'historic'
    input.snapshot!.year = 1800; input.snapshot!.railways = []; input.snapshot!.stations = []
    expect(validateProject(input)).toEqual(input)
  })

  it.each(['ryokan', 'hotel'] as const)('preserves %s lodging details and retired parcel dates without changing commercial classification', (lodgingType) => {
    const input = withSnapshot()
    Object.assign(input.snapshot!.buildings[0], { kind: 'commercial', use: 'lodging', lodgingType, guestRooms: 24, name: '山の湯・旅館「楓」' })
    input.snapshot!.parcels![0].retiredYear = 1920
    expect(parseProject(JSON.stringify(input))).toEqual(input)
    expect(input.snapshot!.buildings[0].kind).toBe('commercial')
  })

  it.each([
    { use: 'shop' }, { lodgingType: 'resort' }, { guestRooms: 0 }, { guestRooms: -1 },
    { guestRooms: 1.5 }, { guestRooms: 10_001 }, { guestRooms: Infinity }, { guestRooms: '24' },
    { name: '' }, { name: '   ' }, { name: '宿'.repeat(201) }, { name: 24 },
  ])('rejects unknown lodging classifications and malformed room counts or names: %j', (change) => {
    const input = withSnapshot()
    Object.assign(input.snapshot!.buildings[0], { kind: 'commercial', use: 'lodging', lodgingType: 'ryokan', guestRooms: 24, name: '旅館 楓' }, change)
    expect(() => validateProject(input)).toThrow()
  })

  it('retains independent optional lodging fields and accepts legacy buildings with none', () => {
    const legacy = withSnapshot()
    expect(validateProject(legacy)).toEqual(legacy)
    const input = withSnapshot()
    input.snapshot!.buildings[0].use = 'lodging'
    expect(validateProject(input)).toEqual(input)
  })

  it.each([1789, 1790.5, Infinity, '1920'])('rejects an invalid retired parcel year: %j', (retiredYear) => {
    const input = withSnapshot()
    Object.assign(input.snapshot!.parcels![0], { retiredYear })
    expect(() => validateProject(input)).toThrow('廃止年')
  })

  it('allows retiring a parcel in the year it was created', () => {
    const input = withSnapshot()
    delete input.snapshot!.parcels![0].developedYear
    input.snapshot!.parcels![0].retiredYear = input.snapshot!.parcels![0].createdYear
    expect(validateProject(input)).toEqual(input)
  })

  it('preserves terrain-based land uses and rejects unknown classifications', () => {
    for (const landUse of ['farmland', 'meadow', 'wetland', 'vacant'] as const) {
      const input = withSnapshot()
      input.snapshot!.areas[0].landUse = landUse
      expect(parseProject(JSON.stringify(input)).snapshot!.areas[0].landUse).toBe(landUse)
    }
    const invalid = withSnapshot()
    Object.assign(invalid.snapshot!.areas[0], { landUse: 'unknown' })
    expect(() => validateProject(invalid)).toThrow('土地の用途')
  })

  it('preserves clipped land boundaries including holes without regenerating geometry', () => {
    const input = withSnapshot()
    input.snapshot!.areas[0].holes = [[{ x: 240, y: 20 }, { x: 255, y: 20 }, { x: 250, y: 35 }]]
    expect(parseProject(JSON.stringify(input))).toEqual(input)
    Object.assign(input.snapshot!.areas[0], { holes: [[{ x: 240, y: 20 }]] })
    expect(() => validateProject(input)).toThrow('頂点')
  })

  it('preserves a rear lot private access route and validates its coordinates', () => {
    const input = withSnapshot()
    input.snapshot!.parcels![0].access = [{ x: 23, y: 50 }, { x: 23, y: 20 }]
    expect(parseProject(JSON.stringify(input))).toEqual(input)
    input.snapshot!.parcels![0].access[1].x = NaN
    expect(() => validateProject(input)).toThrow('横位置')
  })

  it('rejects a saved map belonging to a different seed, era or configuration', () => {
    for (const change of [{ seed: 'other-city' }, { era: 'historic' }, { density: 64 }]) {
      const input = withSnapshot()
      Object.assign(input.snapshot!.config, change)
      expect(() => validateProject(input)).toThrow('一致しません')
    }
  })

  it('accepts the legacy omitted era as the present stage', () => {
    const input = withSnapshot()
    input.snapshot!.config.era = 'present'
    expect(validateProject(input).snapshot!.config.era).toBe('present')
  })

  it.each(['lowland', 'hills', 'mountains'] as const)('preserves the physical relief setting %s in saved geometry', relief => {
    const input = withSnapshot()
    input.config.relief = input.snapshot!.config.relief = relief
    expect(parseProject(JSON.stringify(input))).toEqual(input)
  })

  it('accepts omitted legacy relief as hills while rejecting mismatched or unknown relief', () => {
    const input = withSnapshot()
    input.config.mapSize = input.snapshot!.config.mapSize = 'large'
    input.snapshot!.config.relief = 'hills'
    expect(validateProject(input).snapshot!.config.relief).toBe('hills')
    input.snapshot!.config.relief = 'mountains'
    expect(() => validateProject(input)).toThrow('一致しません')
    Object.assign(input.config, { relief: 'alpine' })
    expect(() => validateProject(input)).toThrow('地形の起伏')
  })

  it('strips unknown nested snapshot properties rather than passing imported objects to rendering', () => {
    const input = withSnapshot()
    Object.assign(input.snapshot!, { unexpected: { value: 'ignored' } })
    Object.assign(input.snapshot!.roads[0], { unexpected: 'ignored' })
    const output = validateProject(input)
    expect(output.snapshot).not.toHaveProperty('unexpected')
    expect(output.snapshot!.roads[0]).not.toHaveProperty('unexpected')
  })

  it.each([
    (map: CityMap) => { map.width = Infinity },
    (map: CityMap) => { map.height = 0 },
    (map: CityMap) => { map.buildings[0].polygon[0].x = Number.NaN },
    (map: CityMap) => { map.roads[0].points[0].y = 1e12 },
    (map: CityMap) => { map.buildings[0].polygon = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] },
    (map: CityMap) => { map.roads[0].points = [{ x: 0, y: 0 }] },
    (map: CityMap) => { map.buildings[0].height = 0 },
    (map: CityMap) => { map.roads[0].width = -1 },
    (map: CityMap) => { map.roads.push({ ...map.roads[0] }) },
    (map: CityMap) => { map.year = 2025.5 },
    (map: CityMap) => { map.parcels![0].roadId = 'missing-road' },
    (map: CityMap) => { map.buildings[0].parcelId = 'missing-parcel' },
    (map: CityMap) => { map.parcels![0].developedYear = 1700 },
    (map: CityMap) => { map.events![0].kind = 'invalid' as 'road' },
    (map: CityMap) => { map.snapshots![0].households = -1 },
    (map: CityMap) => { map.railways[0].elevations = [10] },
    (map: CityMap) => { map.railways[0].elevations![0] = Infinity },
    (map: CityMap) => { map.railways[0].structures![0].kind = 'invalid' as 'bridge' },
  ])('rejects malformed geometry or chronology %#', change => {
    const input = withSnapshot()
    change(input.snapshot!)
    expect(() => validateProject(input)).toThrow()
  })

  it('bounds both geometry arrays and individual paths before reconstructing them', () => {
    const input = withSnapshot()
    input.snapshot!.buildings = Array.from({ length: PROJECT_GEOMETRY_LIMITS.buildings + 1 }, () => input.snapshot!.buildings[0])
    expect(() => validateProject(input)).toThrow('建物')
    input.snapshot = geometry()
    input.snapshot.roads[0].points = Array.from({ length: 20_001 }, () => ({ x: 0, y: 1 }))
    expect(() => validateProject(input)).toThrow('道路の形')
  })

  it('bounds the combined vertex count even when every individual road is within its limit', () => {
    const input = withSnapshot()
    const points = Array.from({ length: 20_000 }, (_, i) => ({ x: i % 2, y: 50 }))
    input.snapshot!.roads = Array.from({ length: Math.floor(PROJECT_GEOMETRY_LIMITS.points / points.length) + 1 }, (_, i) => ({ ...input.snapshot!.roads[0], id: `road-${i}`, points }))
    expect(() => validateProject(input)).toThrow('頂点数')
  })

  it('retains farmland beyond the old small-map limit in a large-map project', () => {
    const input = withSnapshot(), map = input.snapshot!
    input.config.mapSize = map.config.mapSize = 'large'
    map.width = 12_000; map.height = 9000
    map.areas = Array.from({ length: 10_001 }, (_, i) => ({ ...map.areas[0], id: `field-${i}`, landUse: i % 2 ? 'paddy' : 'dry-field' }))
    const restored = parseProject(JSON.stringify(input))
    expect(restored.snapshot!.areas).toEqual(map.areas)
    expect(restored.snapshot!.railways[0].structures![0].length).toBe(200)
  })

  it('preserves a continuous 8192-vertex woodland boundary and a detailed interior ring', () => {
    const input = withSnapshot()
    const ring = (count: number, radius: number) => Array.from({ length: count }, (_, i) => ({ x: 2000 + Math.cos(i * Math.PI * 2 / count) * radius, y: 1500 + Math.sin(i * Math.PI * 2 / count) * radius }))
    input.snapshot!.areas = [{ id: 'large-woodland', kind: 'forest', polygon: ring(8192, 700), holes: [ring(3000, 200)] }]
    const restored = parseProject(JSON.stringify(input))
    expect(restored.snapshot!.areas).toEqual(input.snapshot!.areas)
    input.snapshot!.areas[0].polygon = ring(PROJECT_GEOMETRY_LIMITS.areaRingPoints + 1, 700)
    expect(() => validateProject(input)).toThrow('土地の形')
  })

  it('preserves six-point footprints instead of reducing them to rectangular buildings', () => {
    const input = withSnapshot()
    input.snapshot!.buildings[0].polygon = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 15, y: 20 }, { x: 15, y: 30 }, { x: 10, y: 30 }]
    expect(parseProject(JSON.stringify(input))).toEqual(input)
  })

  it('rejects pins outside the saved map extent', () => {
    const input = withSnapshot()
    input.annotations[0].point.x = input.snapshot!.width + 1
    expect(() => validateProject(input)).toThrow('横位置')
  })

  it('does not replace the last good save when the next map exceeds the local storage budget', () => {
    const memory = new Map([[STORAGE_KEY, JSON.stringify(withSnapshot())]])
    const setItem = vi.fn((key: string, value: string) => memory.set(key, value))
    vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem })
    const large = withSnapshot()
    large.annotations = Array.from({ length: 600 }, (_, i) => ({ ...large.annotations[0], id: `pin-${i}`, note: '物'.repeat(3500) }))
    expect(persistProject(large)).toBe(false)
    expect(setItem).not.toHaveBeenCalled()
    expect(loadProject()).toEqual(withSnapshot())
  })

  it('does not replace the last good save when the browser rejects a write', () => {
    const previous = JSON.stringify(withSnapshot())
    vi.stubGlobal('localStorage', { getItem: () => previous, setItem: () => { throw new Error('QuotaExceededError') } })
    expect(persistProject(sample())).toBe(false)
    expect(loadProject()).toEqual(withSnapshot())
  })

  it('falls back to small and legacy saves when IndexedDB is unavailable', async () => {
    const memory = new Map([[LEGACY_STORAGE_KEY, JSON.stringify({ ...sample(), version: 1 })]])
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) })
    expect(await loadProjectArchive()).toEqual(sample())
    expect(await persistProjectArchive(withSnapshot())).toBe(true)
    expect(await loadProjectArchive()).toEqual(withSnapshot())
  })

  it('reports an archive failure when neither complete-map storage method is available', async () => {
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('SecurityError') } })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } })
    expect(await loadProjectArchive()).toBeNull()
    expect(await persistProjectArchive(withSnapshot())).toBe(false)
  })

  it('bounds an unresponsive archive probe and closes a late connection', async () => {
    vi.useFakeTimers()
    const request: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; result?: { close: () => void } } = {}
    vi.stubGlobal('indexedDB', { open: () => request })
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(withSnapshot()) })
    const loading = loadProjectArchive()
    await vi.advanceTimersByTimeAsync(2501)
    expect(await loading).toEqual(withSnapshot())
    const close = vi.fn()
    request.result = { close }; request.onsuccess!()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects malformed maps before attempting either asynchronous storage method', async () => {
    const open = vi.fn(), setItem = vi.fn()
    vi.stubGlobal('indexedDB', { open }); vi.stubGlobal('localStorage', { setItem })
    const project = withSnapshot(); project.snapshot!.buildings[0].polygon[0].x = Infinity
    expect(await persistProjectArchive(project)).toBe(false)
    expect(open).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled()
  })

  it('cannot replace a complete archive with an unfinished generation', async () => {
    const open = vi.fn(), setItem = vi.fn()
    vi.stubGlobal('indexedDB', { open }); vi.stubGlobal('localStorage', { setItem })
    expect(await persistProjectArchive(sample())).toBe(false)
    expect(open).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled()
  })

  it('writes complete maps to IndexedDB in order without serializing an unused local fallback', async () => {
    const written: Project[] = [], close = vi.fn(), setItem = vi.fn()
    const database = {
      close,
      transaction: () => {
        const tx = {
          oncomplete: undefined as (() => void) | undefined,
          objectStore: () => ({ put: (project: Project) => { written.push(project); queueMicrotask(() => tx.oncomplete?.()) } }),
        }
        return tx
      },
    }
    vi.stubGlobal('indexedDB', { open: () => {
      const request = { result: database, onsuccess: undefined as (() => void) | undefined }
      queueMicrotask(() => request.onsuccess?.())
      return request
    } })
    vi.stubGlobal('localStorage', { setItem })
    const stringify = vi.spyOn(JSON, 'stringify')
    const first = withSnapshot(), second = withSnapshot()
    second.annotations[0].note = '後から保存したメモ'
    expect(await Promise.all([persistProjectArchive(first), persistProjectArchive(second)])).toEqual([true, true])
    expect(written).toEqual([first, second])
    expect(close).toHaveBeenCalledTimes(2)
    expect(setItem).not.toHaveBeenCalled()
    expect(stringify.mock.calls.some(([value]) => value && typeof value === 'object' && 'snapshot' in value)).toBe(false)
  })
})
