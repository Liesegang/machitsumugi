import { describe, expect, it } from 'vitest'
import { buildLayoutFirstLandContext } from './layout-first-land-zoning'
import type { Road } from './types'
import { rectangle } from './geometry'

const collector = (id: string, points: Road['points']): Road => ({ id, points, kind: 'arterial', role: 'collector', width: 9 })

describe('layout-first street and block land context', () => {
  it('measures a physical detour instead of giving the nearby opposite bank station intensity', () => {
    const road = collector('river-detour', [{ x: 0, y: 0 }, { x: 0, y: 800 }, { x: 80, y: 800 }, { x: 80, y: 0 }])
    const context = buildLayoutFirstLandContext({ roads: [road], stations: [{ point: { x: 0, y: 0 } }] })
    expect(context.at(road, { x: 80, y: 80 })).toMatchObject({ stationWalk: 1600, form: 'house', maximumFloors: 2 })
    expect(context.at(road, { x: 0, y: 220 })).toMatchObject({ stationWalk: 220, form: 'apartment' })
    expect(context.at(road, { x: 0, y: 260 }).form).toBe('apartment')
    expect(context.at(road, { x: 0, y: 720 }).form).toBe('house')
  })

  it('does not transfer a station across disconnected, elevated or controlled pavement', () => {
    const stationRoad = collector('station-street', [{ x: 0, y: 0 }, { x: 0, y: 500 }])
    const farBank = collector('far-bank', [{ x: 80, y: 0 }, { x: 80, y: 500 }])
    const crossings: Road[] = [
      { ...collector('viaduct', [{ x: 0, y: 200 }, { x: 80, y: 200 }]), level: 1 },
      { ...collector('motorway', [{ x: 0, y: 300 }, { x: 80, y: 300 }]), controlledAccess: true },
    ]
    const context = buildLayoutFirstLandContext({ roads: [stationRoad, farBank, ...crossings], stations: [{ point: { x: 0, y: 0 } }] })
    expect(context.at(farBank, { x: 80, y: 200 })).toMatchObject({ stationWalk: Infinity, form: 'house' })
    expect(context.at(crossings[0]!, { x: 40, y: 200 }).form).toBe('house')
  })

  it('includes exact T junctions and station entrance offsets in walking distance', () => {
    const main = collector('main', [{ x: 0, y: 0 }, { x: 800, y: 0 }])
    const local: Road = { id: 'branch', points: [{ x: 200, y: 0 }, { x: 200, y: 200 }], kind: 'local', width: 6 }
    const context = buildLayoutFirstLandContext({ roads: [main, local], stations: [{ point: { x: 760, y: 20 }, entrance: { x: 0, y: 10 } }] })
    expect(context.at(local, { x: 200, y: 100 }).stationWalk).toBe(310)
    expect(context.at(main, { x: 250, y: 0 })).toMatchObject({ stationWalk: 260, form: 'apartment' })
    expect(context.at(local, { x: 200, y: 150 }).form).toBe('house')
  })

  it('creates a continuous centre frontage and bounded collector transition without a station', () => {
    const main = collector('centre-spine', [{ x: 0, y: 0 }, { x: 900, y: 0 }])
    const context = buildLayoutFirstLandContext({ roads: [main], center: { x: 0, y: 0 } })
    expect(context.at(main, { x: 80, y: 0 })).toMatchObject({ centerWalk: 80, form: 'shop' })
    expect(context.at(main, { x: 350, y: 0 })).toMatchObject({ centerWalk: 350, form: 'apartment', minimumFloors: 4, maximumFloors: 5 })
    expect(context.at(main, { x: 680, y: 0 })).toMatchObject({ centerWalk: 680, form: 'house' })
  })

  it('uses the actual block on each side of a collector and keeps shallow blocks small', () => {
    const main = collector('block-edge', [{ x: 0, y: 0 }, { x: 800, y: 0 }])
    const context = buildLayoutFirstLandContext({ roads: [main], stations: [{ point: { x: 0, y: 0 } }], blocks: [
      { id: 'shallow', polygon: rectangle(100, -25, 200, 25) },
      { id: 'urban-block', polygon: rectangle(100, 0, 200, 90) },
    ] })
    expect(context.at(main, { x: 250, y: 0 }, { x: 250, y: -10 })).toMatchObject({ blockId: 'shallow', form: 'house' })
    expect(context.at(main, { x: 250, y: 0 }, { x: 250, y: 10 })).toMatchObject({ blockId: 'urban-block', form: 'apartment' })
    expect(context.at(main, { x: 275, y: 0 }, { x: 275, y: 10 }).form).toBe('apartment')
  })

  it('gives connected local blocks compact walkups around metropolitan stations and keeps outer blocks low', () => {
    const main = { ...collector('station-spine', [{ x: 0, y: 0 }, { x: 0, y: 1400 }]), builtYear: 1900 }
    const near: Road = { id: 'walkable-local', kind: 'local', width: 6, builtYear: 1770, points: [{ x: 0, y: 300 }, { x: 200, y: 300 }] }
    const far: Road = { ...near, id: 'outer-local', points: [{ x: 0, y: 1200 }, { x: 200, y: 1200 }] }
    const context = buildLayoutFirstLandContext({ roads: [main, near, far], stations: [{ point: { x: 0, y: 0 }, builtYear: 1900 }], settlement: 'metropolis', blocks: [
      { id: 'station-block', polygon: rectangle(0, 300, 200, 100) }, { id: 'outer-block', polygon: rectangle(0, 1200, 200, 100) },
    ] })
    for (const x of [60, 100, 140]) expect(context.at(near, { x, y: 300 }, { x, y: 310 })).toMatchObject({ form: 'house', stockProfile: 'walkup', minimumFloors: 3, maximumFloors: 4, formAvailableYear: 1900 })
    expect(context.at(far, { x: 100, y: 1200 }, { x: 100, y: 1210 })).toMatchObject({ form: 'house', stockProfile: 'lowrise', maximumFloors: 2 })
    expect(context.at(main, { x: 0, y: 100 })).toMatchObject({ form: 'shop', stockProfile: 'main-street', minimumFloors: 4, maximumFloors: 8 })
    expect(context.at(main, { x: 0, y: 650 })).toMatchObject({ form: 'apartment', stockProfile: 'bar', minimumFloors: 4, maximumFloors: 6 })
  })

  it('dates a qualifying route by its latest connector and resolves equally short routes by earlier opening', () => {
    const old = { ...collector('old-route', [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }]), builtYear: 1770 }
    const future = { ...collector('future-route', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]), builtYear: 1975 }
    const frontage = { ...collector('old-frontage', [{ x: 100, y: 100 }, { x: 300, y: 100 }]), builtYear: 1770 }
    const source = { point: { x: 0, y: 0 }, builtYear: 1900 }
    for (const roads of [[old, future, frontage], [future, old, frontage]]) {
      const context = buildLayoutFirstLandContext({ roads, stations: [source] })
      expect(context.at(frontage, { x: 150, y: 100 })).toMatchObject({ stationWalk: 250, form: 'apartment', formAvailableYear: 1900 })
    }
    const futureOnly = buildLayoutFirstLandContext({ roads: [future, frontage], stations: [source] })
    expect(futureOnly.at(frontage, { x: 150, y: 100 })).toMatchObject({ stationWalk: 250, formAvailableYear: 1975 })
    const futureCentre = buildLayoutFirstLandContext({ roads: [future, frontage], center: { x: 0, y: 0 } })
    expect(futureCentre.at(frontage, { x: 150, y: 100 })).toMatchObject({ centerWalk: 250, form: 'shop', formAvailableYear: 1975 })
  })

  it('gives narrow connected inner streets compact holdings without extending the profile across disconnected or outer blocks', () => {
    const main = { ...collector('spine', [{ x: 0, y: 0 }, { x: 0, y: 1400 }]), builtYear: 1975 }
    const near: Road = { id: 'inner-lane', kind: 'local', width: 4.5, builtYear: 1770, points: [{ x: 0, y: 300 }, { x: 200, y: 300 }] }
    const outer: Road = { ...near, id: 'outer-lane', points: [{ x: 0, y: 1000 }, { x: 200, y: 1000 }] }
    const separate: Road = { ...near, id: 'separate-lane', points: [{ x: 20, y: 100 }, { x: 220, y: 100 }] }
    const context = buildLayoutFirstLandContext({ roads: [main, near, outer, separate], stations: [{ point: { x: 0, y: 0 }, builtYear: 1900 }], settlement: 'metropolis', blocks: [
      { id: 'inner', polygon: rectangle(0, 300, 200, 90) }, { id: 'outer', polygon: rectangle(0, 1000, 200, 90) }, { id: 'separate', polygon: rectangle(20, 100, 200, 90) },
    ] })
    expect(context.at(near, { x: 100, y: 300 }, { x: 100, y: 310 })).toMatchObject({ titleProfile: 'compact', titleAvailableYear: 1975, stockProfile: 'lowrise' })
    expect(context.at(outer, { x: 100, y: 1000 }, { x: 100, y: 1010 }).titleProfile).toBe('ordinary')
    expect(context.at(separate, { x: 100, y: 100 }, { x: 100, y: 110 })).toMatchObject({ stationWalk: Infinity, titleProfile: 'ordinary' })
  })
})
