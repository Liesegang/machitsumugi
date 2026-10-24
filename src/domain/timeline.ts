import type { Building, CityMap, CityTimeline, District, TimelineVersion } from './types'

export const timelineYear = (year: number) => Math.max(1650, Math.min(2025, Math.round(year)))
const active = <T>(version: TimelineVersion<T>, year: number) => version.from <= year && (version.to === undefined || year < version.to)
const atYear = <T>(versions: TimelineVersion<T>[], year: number): T[] => versions.filter(v => active(v, year)).map(v => v.value)

/** Merge actual retired/current versions, retaining untouched natural geometry once. */
export function createCityTimeline(map: CityMap, overrides: Partial<CityTimeline> = {}): CityTimeline {
  const fromYear = overrides.fromYear ?? 1650, throughYear = overrides.throughYear ?? map.year ?? 2025
  function table<T extends { id: string }>(values: T[], supplied: TimelineVersion<T>[] | undefined, opening: (value: T) => number): TimelineVersion<T>[] {
    const ids = new Set(supplied?.map(v => v.value.id))
    return [...(supplied ?? []), ...values.filter(value => !ids.has(value.id)).map(value => ({ from: Math.max(fromYear, opening(value)), value }))]
  }
  return {
    version: 1, fromYear, throughYear,
    roads: table(map.roads, overrides.roads, r => r.builtYear ?? fromYear),
    buildings: table(map.buildings, overrides.buildings, b => b.builtYear ?? fromYear),
    areas: table(map.areas, overrides.areas, () => fromYear),
    railways: table(map.railways, overrides.railways, r => r.builtYear ?? 1900),
    stations: table(map.stations, overrides.stations, () => 1900),
    facilities: table(map.facilities, overrides.facilities, () => fromYear),
    districts: table(map.districts, overrides.districts, d => d.foundedYear ?? fromYear),
    parcels: table(map.parcels ?? [], overrides.parcels, p => p.createdYear),
    buildingStates: overrides.buildingStates ?? [],
    terrainSurfaces: overrides.terrainSurfaces ?? (map.terrainSurface ? [{ from: fromYear, value: map.terrainSurface }] : []),
    events: overrides.events ?? map.events, snapshots: overrides.snapshots ?? map.snapshots, growthLog: overrides.growthLog ?? map.growthLog,
  }
}

/** Pure materialization. No generation, random draws or future-stock filtering. */
export function sliceCityAtYear(map: CityMap, requestedYear: number): CityMap {
  const history = map.timeline
  if (!history) throw new Error('この地図には年代履歴がありません。「街を生成」で履歴を作成してください。')
  const year = Math.max(history.fromYear, Math.min(history.throughYear, timelineYear(requestedYear)))
  const states = new Map<string, CityTimeline['buildingStates'][number]>()
  for (const state of history.buildingStates) if (state.from <= year && (!states.has(state.id) || states.get(state.id)!.from < state.from)) states.set(state.id, state)
  const buildings = atYear(history.buildings, year).map(building => {
    const state = states.get(building.id)
    if (!state) return building
    return { ...building, occupancy: state.occupancy, occupiedHouseholds: state.occupiedHouseholds }
  })
  return {
    ...map, year, config: { ...map.config, targetYear: year }, timeline: history,
    roads: atYear(history.roads, year), buildings,
    areas: atYear(history.areas, year), railways: atYear(history.railways, year), stations: atYear(history.stations, year),
    facilities: atYear(history.facilities, year), districts: atYear(history.districts, year), parcels: atYear(history.parcels, year),
    terrainSurface: atYear(history.terrainSurfaces, year).at(-1),
    // Final-year blocks have no independent dated geometry; omit rather than
    // showing street enclosures that had not yet been built.
    blocks: undefined,
    events: history.events?.filter(event => event.year <= year),
    snapshots: history.snapshots?.filter(snapshot => snapshot.year <= year),
    growthLog: history.growthLog?.filter(stage => stage.year === undefined || stage.year <= year),
  }
}

/** Naming edits belong to a district identity and survive date changes. */
export function renameTimelineDistricts(map: CityMap, rename: (district: District) => District): CityMap {
  return { ...map, districts: map.districts.map(rename), ...(map.timeline ? { timeline: { ...map.timeline, districts: map.timeline.districts.map(v => ({ ...v, value: rename(v.value) })) } } : {}) }
}

/** Remove mutable occupancy from geometry; state deltas carry it separately. */
export function buildingGeometry(building: Building): Building {
  const { occupancy: _occupancy, occupiedHouseholds: _households, ...geometry } = building
  return geometry
}
