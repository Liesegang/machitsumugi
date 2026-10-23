import { describe, expect, it } from 'vitest'
import { isConstructionYear, simulationEndYear, simulationYears } from './simulation-calendar'

describe('canonical simulation calendar', () => {
  it('preserves legacy era presets and lets an explicit exact year override them', () => {
    expect(simulationEndYear({ era: 'historic' })).toBe(1800)
    expect(simulationEndYear({ era: 'railway' })).toBe(1930)
    expect(simulationEndYear({})).toBe(2025)
    expect(simulationEndYear({ era: 'historic', targetYear: 1963 })).toBe(1963)
    expect(simulationEndYear({ targetYear: 1649 })).toBe(1650)
    expect(simulationEndYear({ targetYear: 2026 })).toBe(2025)
    expect(simulationEndYear({ targetYear: NaN })).toBe(2025)
  })
  it('includes the exact as-of year without importing a future construction round', () => {
    expect(simulationYears(1650)).toEqual([1650])
    expect(simulationYears(1698)).toEqual([1650, 1698])
    expect(simulationYears(1713)).toEqual([1650, 1700, 1705, 1710, 1713])
    expect(isConstructionYear(1713)).toBe(false)
    const through1963 = simulationYears(1963).filter(isConstructionYear)
    expect(through1963).toEqual(simulationYears(2025).filter(year => year <= 1963 && isConstructionYear(year)))
  })
})
