import { describe, expect, it } from 'vitest'
import { simulateUrbanGrowth } from './urban-growth'
import type { UrbanGrowthInput } from './urban-growth'

const input: UrbanGrowthInput = { width: 1400, height: 1200, seed: 'chronological-railway', type: 'castle', center: { x: 680, y: 560 }, core: null, areas: [], arterial: true, railway: true, stationPoints: [], density: 30, era: 'railway' }
describe('railway planning after the actual inherited town', () => {
  it('plans once from the 1895 streets and continues the same history without changing the caller', () => {
    const inherited = simulateUrbanGrowth({ ...input, railway: false, untilYear: 1895 })
    let calls = 0
    const result = simulateUrbanGrowth({ ...input, onRailwayPlanning: context => {
      calls++
      expect(context.roads).toEqual(inherited.roads)
      expect(context.roads.every(road => road.builtYear < 1900)).toBe(true)
      expect(context.centers.every(center => center.activeYear < 1900)).toBe(true)
      const road = context.roads.find(road => road.points.length > 2)!, station = road.points[Math.floor(road.points.length / 2)]!
      return { stationPoints: [station] }
    } })
    expect(calls).toBe(1)
    expect(result.centers.some(center => center.kind === 'station' && center.activeYear === 1900)).toBe(true)
    expect(input.stationPoints).toEqual([])
  })
  it('does not survey or apply a future railway to the founding era', () => {
    const historic = simulateUrbanGrowth({ ...input, era: 'historic', onRailwayPlanning: () => { throw new Error('Future railway affected founding streets') } })
    expect(historic.roads).toEqual(simulateUrbanGrowth({ ...input, era: 'historic', railway: false }).roads)
    expect(historic.centers.some(center => center.kind === 'station')).toBe(false)
  })
})
