import { describe, expect, it } from 'vitest'
import { ownReligiousPrecinct } from './test-support/precinct-audit'
import type { Area, Building } from './types'

const rectangle = (x: number, y: number, width: number, height: number) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]
const building: Building = { id: 'facility-building-shrine-relocation-1900-2', polygon: rectangle(3, 3, 4, 4), kind: 'public', height: 2 }
const precinct: Area = { id: 'facility-lot-shrine-relocation-1900-2', polygon: rectangle(0, 0, 10, 10), kind: 'park' }
const town = { config: { type: 'onsen' as const }, facilities: [] }

describe('independent religious precinct audit', () => {
  it('allows only the exact own shrine lot, with the whole building inside', () => {
    expect(ownReligiousPrecinct(building, precinct, town)).toBe(true)
    expect(ownReligiousPrecinct(building, { ...precinct, id: 'neighboring-park' }, town)).toBe(false)
    expect(ownReligiousPrecinct(building, { ...precinct, id: 'facility-lot-shrine-relocation-1900-3' }, town)).toBe(false)
    expect(ownReligiousPrecinct(building, { ...precinct, kind: 'water' }, town)).toBe(false)
    expect(ownReligiousPrecinct(building, { ...precinct, kind: 'forest' }, town)).toBe(false)
    expect(ownReligiousPrecinct({ ...building, polygon: rectangle(8, 3, 4, 4) }, precinct, town)).toBe(false)
    expect(ownReligiousPrecinct(building, { ...precinct, holes: [rectangle(4, 4, 1, 1)] }, town)).toBe(false)
  })
  it('rejects a footprint crossing a concave precinct gap even with all vertices inside', () => {
    const notched: Area = { ...precinct, polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 6, y: 10 }, { x: 6, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }] }
    expect(ownReligiousPrecinct({ ...building, polygon: rectangle(2, 2, 6, 5) }, notched, town)).toBe(false)
  })
  it('allows the historical origin only for an actual temple shrine facility', () => {
    const origin = { ...building, id: 'origin-shrine-building' }, core = { ...precinct, id: 'historic-core' }
    const temple = { config: { type: 'temple' as const }, facilities: [{ id: 'origin', kind: 'shrine' as const }] }
    expect(ownReligiousPrecinct(origin, core, temple)).toBe(true)
    expect(ownReligiousPrecinct(origin, core, { ...temple, facilities: [] })).toBe(false)
    expect(ownReligiousPrecinct(origin, core, { ...temple, config: { type: 'castle' } })).toBe(false)
    expect(ownReligiousPrecinct(origin, { ...core, kind: 'water' }, temple)).toBe(false)
  })
})
