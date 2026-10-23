import { describe, expect, it } from 'vitest'
import { RailwayRoadConstraints } from './railway-road-constraints'

const railway = new RailwayRoadConstraints([{ id: 'main', points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], builtYear: 1900 }])
describe('road construction after a railway opens', () => {
  it('prices a real level crossing once even when a street vertex lies on the track', () => {
    expect(railway.pathCost([{ x: 50, y: -50 }, { x: 50, y: 0 }, { x: 50, y: 50 }], 'lane')).toBe(600)
    expect(railway.pathCost([{ x: 50, y: -50 }, { x: 50, y: 50 }], 'lane')).toBe(600)
  })
  it('keeps a station forecourt ending at the platform distinct from a road crossing', () => {
    expect(railway.pathCost([{ x: 50, y: 50 }, { x: 50, y: 0 }], 'access')).toBe(0)
  })
  it('rejects acute level crossings and surface streets occupying the track', () => {
    expect(railway.pathCost([{ x: -100, y: -10 }, { x: 200, y: 10 }], 'collector')).toBe(Infinity)
    expect(railway.pathCost([{ x: 20, y: 0 }, { x: 200, y: 0 }], 'lane')).toBe(Infinity)
  })
  it('charges railway land for close parallel roads without penalising an ordinary offset road', () => {
    expect(railway.pathCost([{ x: 20, y: 6 }, { x: 200, y: 6 }], 'lane')).toBeGreaterThan(0)
    expect(railway.pathCost([{ x: 20, y: 30 }, { x: 200, y: 30 }], 'lane')).toBe(0)
  })
  it('makes repeated side changes more expensive than two separate crossings', () => {
    const close = railway.pathCost([{ x: 20, y: -20 }, { x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: -20 }], 'lane')
    const far = railway.pathCost([{ x: 20, y: -20 }, { x: 20, y: 20 }, { x: 800, y: 20 }, { x: 800, y: -20 }], 'lane')
    expect(far).toBe(1200)
    expect(close).toBeGreaterThan(far)
  })
  it('charges a grade-separated structure instead of imposing a level-crossing angle on a motorway', () => {
    expect(railway.pathCost([{ x: -100, y: -10 }, { x: 200, y: 10 }], 'expressway')).toBe(1800)
  })
})
