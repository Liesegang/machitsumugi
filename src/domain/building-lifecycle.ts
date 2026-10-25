import type { Building } from './types'

export interface BuildingLifeAccount {
  buildingId: string; builtYear: number; lastYear: number; serviceYears: number
  structureCost: number; cash: number; demolitionBond: number; condition: number; vacantYears: number
}
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
function variation(seed: string) {
  let hash = 2166136261
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return (hash >>> 0) / 4294967296
}

/** Fictional ordinary-stock assumptions, not an engineering/legal lifespan.
 * Maintenance preserves condition but cannot make an ordinary physical frame
 * immortal. Historic monuments are outside this frontage-building model. */
export function buildingServiceYears(seed: string, building: Pick<Building, 'id' | 'builtYear' | 'height' | 'kind' | 'use'>): number {
  const modernFrame = (building.builtYear ?? 1650) >= 1955 && building.height >= 3
  const [minimum, range] = building.kind === 'industrial' ? [35, 25] : modernFrame ? [65, 30] : building.use === 'lodging' ? [45, 25] : [50, 30]
  return minimum! + Math.floor(variation(`${seed}:structure-life:${building.id}:${building.builtYear}`) * range!)
}

/** A new owner's construction contribution escrows its eventual clearance.
 * The bond cannot pay maintenance or finance a replacement. Operating surplus
 * must actually accumulate before a new physical structure can be purchased. */
export function newBuildingLifeAccount(seed: string, building: Building, footprintArea: number): BuildingLifeAccount {
  const structureCost = Math.max(1, footprintArea) * Math.max(1, building.height) * .9
  return { buildingId: building.id, builtYear: building.builtYear ?? 1650, lastYear: building.builtYear ?? 1650,
    serviceYears: buildingServiceYears(seed, building), structureCost, cash: 0, demolitionBond: structureCost * .06, condition: 1, vacantYears: 0 }
}

/** Actual use supplies bounded annual receipts. Empty stock earns nothing and
 * spends its reserve; unpaid upkeep deteriorates it until vacancy/clearance.
 * Returns a detached account so a past account/history is never edited. */
export function advanceBuildingLife(account: BuildingLifeAccount, year: number, utilization: number) {
  const elapsed = Math.max(0, year - account.lastYear), used = clamp(utilization, 0, 1)
  const receipts = account.structureCost * .04 * used * elapsed
  const maintenanceDue = account.structureCost * (account.builtYear < 1955 ? .011 : .008) * elapsed
  const maintenancePaid = Math.min(account.cash + receipts, maintenanceDue)
  const funded = maintenanceDue > 0 ? maintenancePaid / maintenanceDue : 1
  const condition = clamp(account.condition - elapsed / account.serviceYears * .1 - (1 - funded) * elapsed * .025, 0, 1)
  const vacantYears = used < .1 ? account.vacantYears + elapsed : 0
  const age = Math.max(0, year - account.builtYear)
  return {
    account: { ...account, lastYear: Math.max(account.lastYear, year), cash: account.cash + receipts - maintenancePaid, condition, vacantYears },
    receipts, maintenanceDue, maintenancePaid, age,
    renewalDue: used >= .25 && (age >= account.serviceYears || condition < .55),
    retirementDue: age >= account.serviceYears + 10 || condition <= .22 || vacantYears >= 30,
  }
}

/** Reuse the surveyed pad, but pay for the complete new frame, a foundation
 * refurbishment and its new clearance bond. Old clearance uses only its bond. */
export function buildingReplacementInvoice(account: BuildingLifeAccount, formationCost: number, replacementStructureCost = account.structureCost) {
  const construction = replacementStructureCost, foundation = Math.max(0, formationCost) * .25, newBond = construction * .06
  return { construction, foundation, newBond, demolition: account.demolitionBond, cashRequired: construction + foundation + newBond }
}

export function fundBuildingReplacement(seed: string, account: BuildingLifeAccount, building: Building, footprintArea: number, formationCost: number): BuildingLifeAccount | null {
  const next = newBuildingLifeAccount(seed, building, footprintArea)
  const invoice = buildingReplacementInvoice(account, formationCost, next.structureCost)
  if (!Number.isFinite(invoice.cashRequired) || invoice.cashRequired > account.cash + 1e-7) return null
  return { ...next, cash: Math.max(0, account.cash - invoice.cashRequired) }
}
