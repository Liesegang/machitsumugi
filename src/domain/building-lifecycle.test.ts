import { describe, expect, it } from 'vitest'
import { advanceBuildingLife, buildingReplacementInvoice, buildingServiceYears, fundBuildingReplacement, newBuildingLifeAccount } from './building-lifecycle'
import { rectangle } from './geometry'
import type { Building } from './types'

const shop: Building = { id: '1770-shop', builtYear: 1770, kind: 'commercial', height: 2, polygon: rectangle(0, 0, 10, 12) }
describe('funded ordinary physical building service life', () => {
  it('earns and pays upkeep before buying a complete replacement, without changing its original account', () => {
    const initial = newBuildingLifeAccount('life', shop, 120), saved = structuredClone(initial)
    let current = initial
    for (let year = 1775; year <= 1850; year += 5) current = advanceBuildingLife(current, year, 1).account
    const invoice = buildingReplacementInvoice(current, 40), replacement = { ...shop, id: 'replacement-1850', builtYear: 1850 }
    const rebuilt = fundBuildingReplacement('life', current, replacement, 120, 40)!
    expect(rebuilt).not.toBeNull()
    expect(rebuilt.cash).toBeCloseTo(current.cash - invoice.cashRequired)
    expect(rebuilt.condition).toBe(1)
    expect(rebuilt.builtYear).toBe(1850)
    expect(initial).toEqual(saved)
    expect(fundBuildingReplacement('life', initial, replacement, 120, 40)).toBeNull()
    expect(fundBuildingReplacement('life', current, { ...replacement, height: 10 }, 120, 40)).toBeNull()
    expect(rebuilt.cash).toBeGreaterThanOrEqual(0)
  })
  it('does not maintain vacant unprofitable stock forever or borrow its ring-fenced demolition money', () => {
    const initial = newBuildingLifeAccount('vacant', shop, 120), empty = advanceBuildingLife(initial, 1800, 0)
    expect(empty.account.cash).toBe(0)
    expect(empty.maintenancePaid).toBe(0)
    expect(empty.account.condition).toBeLessThan(.3)
    expect(empty.account.demolitionBond).toBe(initial.demolitionBond)
    expect(empty.retirementDue).toBe(true)
    expect(empty.renewalDue).toBe(false)
    expect(fundBuildingReplacement('vacant', empty.account, { ...shop, id: 'unfunded', builtYear: 1800 }, 120, 0)).toBeNull()
  })
  it.each([{ ...shop, kind: 'industrial' as const }, { ...shop, use: 'lodging' as const }, { ...shop, builtYear: 1965, height: 5 }])('gives every ordinary use a finite deterministic frame life', building => {
    const years = buildingServiceYears('stable', building)
    expect(years).toBe(buildingServiceYears('stable', building))
    expect(years).toBeGreaterThanOrEqual(35)
    expect(years).toBeLessThan(100)
    const old = advanceBuildingLife(newBuildingLifeAccount('stable', building, 120), building.builtYear! + years + 10, 1)
    expect(old.retirementDue).toBe(true)
  })
})
