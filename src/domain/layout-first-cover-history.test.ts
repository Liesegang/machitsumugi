import { describe, expect, it } from 'vitest'
import { layoutFirstCoverHistory } from './layout-first-cover-history'
import { buildLayoutFirstCover } from './layout-first-cover'
import type { LayoutFirstCoverInput } from './layout-first-cover'
import type { Area, CityConfig, Point, TimelineVersion } from './types'
import { pointInRegion, rectangle } from './geometry'

const config: CityConfig = { name: '年代林市', seed: 'dated-canopy', type: 'post', terrain: 'plain', density: 60, forest: 100, railway: false, stations: 1, arterial: true, facilities: [], targetYear: 2025 }
const forest: Area = { id: 'forest-0', kind: 'forest', polygon: rectangle(0, 0, 800, 600), name: '試験の森' }
const campus = { polygon: rectangle(500, 350, 140, 130) }
const input = (): LayoutFirstCoverInput => ({ config, width: 800, height: 600, terrain: { areas: [forest], elevation: () => 20, slope: () => 0, waterAt: () => false, wetness: () => .1 }, zones: [], parcels: [{ id: 'home', polygon: rectangle(200, 250, 60, 55), entrance: { x: 230, y: 250 }, roadId: 'old-street', createdYear: 1955, developedYear: 1955, use: 'residential' }], roads: [{ id: 'old-street', width: 6, kind: 'local', points: [{ x: 50, y: 200 }, { x: 750, y: 200 }], builtYear: 1900 }], reserves: [campus] })
const active = (versions: TimelineVersion<Area>[], year: number) => versions.filter(v => v.from <= year && (v.to === undefined || year < v.to)).map(v => v.value)
const forestAt = (versions: TimelineVersion<Area>[], point: Point, year: number) => active(versions, year).some(area => (area.kind === 'forest' || area.landUse === 'woodland') && pointInRegion(point, area))

describe('dated layout-first natural cover', () => {
  it('retains the actual old forest until each road, household title and campus is acquired', () => {
    const data = input(), finalCover = buildLayoutFirstCover(data), versions = layoutFirstCoverHistory({ input: data, finalCover, reserveDates: [{ region: campus, from: 1965 }] })
    for (const point of [{ x: 300, y: 200 }, { x: 220, y: 270 }, { x: 550, y: 400 }]) expect(forestAt(versions, point, 1850)).toBe(true)
    expect(forestAt(versions, { x: 300, y: 200 }, 1900)).toBe(false)
    expect(forestAt(versions, { x: 220, y: 270 }, 1954)).toBe(true)
    expect(forestAt(versions, { x: 220, y: 270 }, 1955)).toBe(false)
    expect(forestAt(versions, { x: 550, y: 400 }, 1964)).toBe(true)
    expect(forestAt(versions, { x: 550, y: 400 }, 1965)).toBe(false)
    expect(active(versions, 2025).slice().sort((a, b) => a.id.localeCompare(b.id))).toEqual(finalCover.slice().sort((a, b) => a.id.localeCompare(b.id)))
    expect(versions.every(v => v.to === undefined || v.from < v.to)).toBe(true)
  })
  it('uses dated road widths instead of clearing modern shoulders from the1650forest', () => {
    const data = input(), old = { ...data.roads[0]!, width: 4, builtYear: 1650 }, modern = { ...old, width: 12, modifiedYear: 1955 }
    data.roads = [modern]; data.parcels = []; data.reserves = []
    const finalCover = buildLayoutFirstCover(data)
    const versions = layoutFirstCoverHistory({ input: data, finalCover, reserveDates: [], roadHistory: [{ from: 1650, to: 1955, value: old }, { from: 1955, value: modern }] })
    expect(forestAt(versions, { x: 300, y: 204 }, 1900)).toBe(true)
    expect(forestAt(versions, { x: 300, y: 204 }, 1955)).toBe(false)
    expect(forestAt(versions, { x: 300, y: 200 }, 1650)).toBe(false)
  })
  it('keeps unchanged forest components in one version rather than cloning their geometry at every later date', () => {
    const data = input(), isolated: Area = { id: 'separate-wood', polygon: rectangle(900, 0, 200, 600), kind: 'forest', name: '独立の森' }
    data.width = 1100; data.terrain.areas.push(isolated)
    const finalCover = buildLayoutFirstCover(data), versions = layoutFirstCoverHistory({ input: data, finalCover, reserveDates: [{ region: campus, from: 1965 }] })
    const past = versions.filter(v => v.value.id === isolated.id)
    expect(past).toHaveLength(1); expect(past[0]!.value).toBe(isolated); expect(past[0]!.from).toBe(1650); expect(past[0]!.to).toBe(2025)
  })
  it('does no geometric or terrain work for forest=0 and dates fields to their actual access road', () => {
    const data = input(); data.terrain.areas = []; data.parcels = []; data.reserves = []
    data.terrain.elevation = () => { throw new Error('History must not rerun a terrain survey') }
    const field: Area = { id: 'layout-field-new-access-0-1', kind: 'field', landUse: 'dry-field', polygon: rectangle(100, 100, 60, 30) }
    const grass: Area = { id: 'land-layout-meadow-0', kind: 'park', landUse: 'meadow', polygon: rectangle(0, 0, 800, 600) }
    data.roads = [{ id: 'new-access', points: [{ x: 0, y: 90 }, { x: 800, y: 90 }], builtYear: 1975, kind: 'local', width: 6 }]
    const versions = layoutFirstCoverHistory({ input: data, finalCover: [grass, field], reserveDates: [] })
    expect(versions).toEqual([{ from: 1650, value: grass }, { from: 1975, value: field }])
    expect(active(versions, 1900)).toEqual([grass]); expect(active(versions, 2025)).toEqual([grass, field])
  })
})
