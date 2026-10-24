import { describe, expect, it } from 'vitest'
import { riparianWetlandMargin } from './riparian-wetland'
import type { TerrainModel } from './terrain'
const bank = (height: number, distance: number, slope = .01): Pick<TerrainModel, 'channelAt' | 'elevation' | 'slope' | 'wetness' | 'waterAt'> => ({
  channelAt: () => ({ point: { x: 0, y: 0 }, tangent: { x: 0, y: 1 }, bankDistance: distance, width: 30, surfaceElevation: 10, riverId: 'river' }),
  elevation: () => 10 + height, slope: () => slope, wetness: () => .7, waterAt: () => false,
})
describe('relative water stage controls wet bank cover', () => {
  it('keeps an elevated river terrace dry even immediately beside the channel', () => {
    expect(riparianWetlandMargin({ x: 0, y: 0 }, bank(3, 5))).toBeLessThan(0)
  })
  it('retains low saturated swales beyond a former fixed60m ribbon', () => {
    expect(riparianWetlandMargin({ x: 0, y: 0 }, bank(.15, 110))).toBeGreaterThan(0)
    expect(riparianWetlandMargin({ x: 0, y: 0 }, bank(.15, 20))).toBeGreaterThan(0)
    expect(riparianWetlandMargin({ x: 0, y: 0 }, bank(1.5, 20))).toBeLessThan(0)
  })
  it('excludes steep banks, dry ground, open water and points without a channel survey', () => {
    const p = { x: 0, y: 0 }
    expect(riparianWetlandMargin(p, bank(.1, 20, .15))).toBeLessThan(0)
    expect(riparianWetlandMargin(p, { ...bank(.1, 20), wetness: () => .3 })).toBeLessThan(0)
    expect(riparianWetlandMargin(p, { ...bank(.1, 20), waterAt: () => true })).toBeLessThan(0)
    expect(riparianWetlandMargin(p, { ...bank(.1, 20), channelAt: () => null })).toBeLessThan(0)
  })
})
