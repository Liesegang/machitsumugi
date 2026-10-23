import { expect, it } from 'vitest'
import { simulateUrbanGrowth } from './urban-growth'

it('captures completed civic construction rounds without changing or sharing growth state', () => {
  const input = { width: 1400, height: 1200, seed: 'civic-snapshot', type: 'post' as const, center: { x: 700, y: 600 }, core: null, areas: [], arterial: false, railway: false, stationPoints: [], density: 0, settlement: 'village' as const, untilYear: 1963 }
  const baseline = simulateUrbanGrowth(input), years: number[] = []
  let occupied = 0
  const observed = simulateUrbanGrowth({ ...input, onCivicPopulation: (year, population) => {
    years.push(year); occupied += population.length
    // Consumers cannot accidentally corrupt later model years through aliases.
    for (const cell of population) { cell.point.x = -1e9; cell.households = -100 }
  } })
  expect(years).toEqual([1955, 1960])
  expect(occupied).toBeGreaterThan(0)
  expect(observed).toEqual(baseline)
})
