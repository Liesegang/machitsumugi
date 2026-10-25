import { describe, expect, it } from 'vitest'
import { developLand } from './land-development'
import { buildingServiceYears } from './building-lifecycle'
import { pointInPolygon, polygonsOverlap, rectangle } from './geometry'
import type { CityConfig, Road } from './types'

const config: CityConfig = { name: '旧街道町', seed: 'ordinary-service-life', type: 'post', terrain: 'plain', density: 85, forest: 0, railway: false, stations: 0, arterial: false, facilities: [], settlement: 'regional-city' }
const roads: Road[] = [{ id: 'market-1770', points: [{ x: 150, y: 500 }, { x: 1200, y: 500 }], kind: 'local', role: 'collector', width: 6, builtYear: 1770 }]
const run = (year: number, changes: Partial<CityConfig> = {}, canPlace: (polygon: Road['points'], year: number) => boolean = () => true) => developLand({ config: { ...config, ...changes, targetYear: year }, roads, center: { x: 650, y: 500 }, stations: [], slope: () => 0, canPlace })
const prefix = (result: ReturnType<typeof run>, year: number) => ({
  buildings: result.history.buildings.filter(v => v.from <= year).map(v => ({ ...v, to: v.to !== undefined && v.to <= year ? v.to : undefined })),
  parcels: result.history.parcels.filter(v => v.from <= year).map(v => ({ ...v, to: v.to !== undefined && v.to <= year ? v.to : undefined })),
  states: result.history.buildingStates.filter(v => v.from <= year), events: result.events.filter(v => v.year <= year),
})

describe('ordinary commercial frames are not immortal title identities', () => {
  it('replaces a1770shop with actual distinct physical buildings and keeps1850/1900 time-travel prefixes exact', () => {
    const first = run(1770), present = run(2025)
    const old = first.buildings.find(b => b.kind === 'commercial' && b.builtYear === 1770)!
    expect(old).toBeTruthy()
    const oldVersion = present.history.buildings.find(v => v.value.id === old.id)!
    expect(oldVersion.value).toMatchObject({ builtYear: 1770, parcelId: old.parcelId })
    expect(oldVersion.to).toBeLessThan(1900)
    expect(present.buildings.some(b => b.id === old.id)).toBe(false)
    const current = present.buildings.find(b => b.parcelId === old.parcelId)!
    expect(current).toBeTruthy(); expect(current.id).not.toBe(old.id)
    expect(current.builtYear).toBeGreaterThan(1900)
    const originalTitle = first.parcels.find(p => p.id === old.parcelId)!, currentTitle = present.parcels.find(p => p.id === old.parcelId)!
    expect(currentTitle.createdYear).toBe(originalTitle.createdYear)
    expect(currentTitle.polygon).toEqual(originalTitle.polygon)
    expect(current.polygon.every(p => pointInPolygon(p, currentTitle.polygon))).toBe(true)
    for (const year of [1850, 1900]) expect(prefix(present, year)).toEqual(prefix(run(year), year))
    expect(new Set(present.history.buildings.map(v => v.value.id)).size).toBe(present.history.buildings.length)
    expect(present.lifecycle.reduce((n, r) => n + r.construction, 0)).toBeGreaterThan(0)
    let previousCapital = 0
    for (const round of present.lifecycle) {
      expect(round.cashBalance).toBeGreaterThanOrEqual(0)
      expect(previousCapital + round.receipts + round.initialBonds).toBeCloseTo(round.maintenance + round.construction + round.clearance + round.releasedCapital + round.cashBalance + round.bondBalance, 5)
      previousCapital = round.cashBalance + round.bondBalance
    }
  })
  it('does not produce an infinite pristine ancient stock after demand declines', () => {
    const declining = run(2025, { settlement: 'village', density: 70, populationTrend: 'declining' })
    expect(declining.lifecycle.some(r => r.retired > 0)).toBe(true)
    expect(declining.events.some(e => e.id.startsWith('lifecycle-clearance-'))).toBe(true)
    for (const building of declining.buildings) expect(2025 - building.builtYear!).toBeLessThan(buildingServiceYears(config.seed, building) + 10)
    for (const previous of declining.history.buildings.filter(v => v.to !== undefined)) expect(declining.events.some(e => e.kind === 'acquisition' && e.entityId === previous.value.id && e.year === previous.to)).toBe(true)
    expect(prefix(declining, 1900)).toEqual(prefix(run(1900, { settlement: 'village', density: 70, populationTrend: 'declining' }), 1900))
  })
  it('does not finance a replacement through a newly obstructed private frontage or building pad', () => {
    const historic = run(1800), old = historic.buildings.find(b => b.kind === 'commercial')!, center = old.polygon[0]!
    const obstruction = rectangle(center.x - 1, center.y - 1, 3, 3)
    const blocked = run(2025, {}, (polygon, year) => year < 1850 || !polygonsOverlap(polygon, obstruction))
    expect(blocked.buildings.every(b => !polygonsOverlap(b.polygon, obstruction))).toBe(true)
    expect(blocked.history.buildings.filter(v => v.from >= 1850).every(v => !polygonsOverlap(v.value.polygon, obstruction))).toBe(true)
    expect(blocked.events.some(e => e.kind === 'acquisition' && e.reason === '後年の交通用地取得')).toBe(true)
  })
})
