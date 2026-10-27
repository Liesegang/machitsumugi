import { describe, expect, it } from 'vitest'
import { streetHolding } from './street-holding'
import type { StreetStock } from './street-holding'

const stocks = ['compact', 'ordinary', 'garden', 'walkup', 'mixed'] as const satisfies readonly StreetStock[]
const percentile = (values: number[], fraction: number) => values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)]!
const samples = (stock: StreetStock) => Array.from({ length: 600 }, (_, i) => streetHolding('holding-study', `holding-${i}`, stock, .85, `street-side-${Math.floor(i / 6)}`))

describe('street acquisition profiles', () => {
  it('is stable for a real holding across calls, iteration order and physical building renewals', () => {
    const keys = ['main-left-20', 'main-left-21', 'main-right-20', 'lane-west-4']
    const original = new Map(keys.map(key => [key, streetHolding('city', key, 'ordinary', .7, 'main-left')]))
    for (const key of keys.slice().reverse()) {
      expect(streetHolding('city', key, 'ordinary', .7, 'main-left')).toEqual(original.get(key))
    }
    expect(streetHolding('other-city', keys[0]!, 'ordinary', .7, 'main-left')).not.toEqual(original.get(keys[0]!))
  })

  it('provides several materially different holding and roof sizes rather than tiny perturbations of one prototype', () => {
    for (const stock of stocks) {
      const values = samples(stock), frontage = values.map(v => v.frontage), acquisition = values.map(v => v.frontage * v.depth), roof = values.map(v => v.frontage * v.depth * v.coverage)
      expect(percentile(frontage, .9) / percentile(frontage, .1)).toBeGreaterThan(1.25)
      expect(percentile(acquisition, .9) / percentile(acquisition, .1)).toBeGreaterThan(1.4)
      expect(percentile(roof, .9) / percentile(roof, .1)).toBeGreaterThan(1.45)
      expect(percentile(values.map(v => v.frontGap), .9) - percentile(values.map(v => v.frontGap), .1)).toBeGreaterThan(.55)
    }
  })

  it('retains a shared building line inside a street cohort while adjacent acquisition cohorts can differ', () => {
    for (const stock of stocks) {
      const cohorts = Array.from({ length: 40 }, (_, c) => Array.from({ length: 8 }, (_, i) => streetHolding('cohort-city', `${c}-${i}`, stock, .8, `frontage-band-${c}`)))
      for (const cohort of cohorts) expect(Math.max(...cohort.map(p => p.frontGap)) - Math.min(...cohort.map(p => p.frontGap))).toBeLessThan(.6)
      const means = cohorts.map(cohort => cohort.reduce((sum, p) => sum + p.frontGap / cohort.length, 0))
      expect(percentile(means, .9) - percentile(means, .1)).toBeGreaterThan(.55)
    }
  })

  it('keeps stock purpose visible in acquisition and roof proportions', () => {
    const compact = samples('compact'), garden = samples('garden'), apartments = samples('walkup'), mixed = samples('mixed')
    expect(percentile(garden.map(p => p.frontage * p.depth), .5)).toBeGreaterThan(percentile(compact.map(p => p.frontage * p.depth), .5) * 2)
    expect(percentile(apartments.map(p => p.frontage), .5)).toBeGreaterThan(percentile(compact.map(p => p.frontage), .5) * 1.8)
    expect(percentile(garden.map(p => p.coverage), .5)).toBeLessThan(percentile(compact.map(p => p.coverage), .5))
    expect(percentile(apartments.map(p => p.aspect), .5)).toBeGreaterThan(percentile(compact.map(p => p.aspect), .5) * 1.5)
    expect(percentile(mixed.map(p => p.frontGap), .5)).toBeLessThan(percentile(garden.map(p => p.frontGap), .5))
  })

  it('bounds every profile even for saturated or invalid demand values', () => {
    const widthBounds = { compact: [6.8, 15], ordinary: [9, 22], garden: [13, 29], walkup: [18, 32], mixed: [15, 32] }
    for (const stock of stocks) for (const intensity of [-10, 0, .5, 1, 10, NaN, Infinity]) for (let i = 0; i < 20; i++) {
      const profile = streetHolding('bounds', `site-${i}`, stock, intensity, 'street')
      expect(Object.values(profile).every(Number.isFinite)).toBe(true)
      expect(profile.frontage).toBeGreaterThanOrEqual(widthBounds[stock][0]!)
      expect(profile.frontage).toBeLessThanOrEqual(widthBounds[stock][1]!)
      expect(profile.depth).toBeGreaterThanOrEqual(18)
      expect(profile.depth).toBeLessThanOrEqual(40)
      expect(profile.coverage).toBeGreaterThanOrEqual(.28)
      expect(profile.coverage).toBeLessThanOrEqual(.65)
      expect(profile.widthRatio).toBeGreaterThanOrEqual(.65)
      expect(profile.widthRatio).toBeLessThanOrEqual(.9)
      expect(Math.abs(profile.sideBias)).toBeLessThanOrEqual(.13)
    }
  })

  it('acquires distinct larger business sites instead of enlarging every ordinary house', () => {
    const homes=samples('ordinary'),offices=samples('office'),retail=samples('retail')
    expect(percentile(offices.map(p=>p.frontage*p.depth*p.coverage),.5)).toBeGreaterThan(percentile(homes.map(p=>p.frontage*p.depth*p.coverage),.5)*4)
    expect(percentile(retail.map(p=>p.frontage),.5)).toBeGreaterThan(35)
    for(const stock of ['office','retail'] as const)for(const profile of samples(stock)){
      expect(profile.frontage).toBeGreaterThanOrEqual(30)
      expect(profile.frontage).toBeLessThanOrEqual(76)
      expect(profile.depth).toBeGreaterThanOrEqual(32)
      expect(profile.depth).toBeLessThanOrEqual(62)
      expect(profile.coverage).toBeGreaterThanOrEqual(.38)
      expect(profile.coverage).toBeLessThanOrEqual(.7)
    }
  })
})
