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
  it('reuses an inherited crossing and rejects another surface crossing beside it', () => {
    const constraints = new RailwayRoadConstraints([{ id: 'main', points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] }])
    expect(constraints.updateExistingRoads([{ id: 'old', points: [{ x: 200, y: -100 }, { x: 200, y: 100 }], width: 6, kind: 'local' }])).toBe(true)
    expect(constraints.pathCost([{ x: 220, y: -100 }, { x: 220, y: 100 }], 'lane')).toBe(Infinity)
    expect(constraints.edgeCost({ x: 220, y: -100 }, { x: 220, y: 100 }, 'lane')).toBe(Infinity)
    expect(constraints.pathCost([{ x: 200, y: -100 }, { x: 200, y: 100 }], 'lane')).toBe(600)
    expect(constraints.pathCost([{ x: 800, y: -100 }, { x: 800, y: 100 }], 'lane')).toBe(600)
  })
  it('does not confuse a platform access or elevated motorway with a surface crossing', () => {
    const constraints = new RailwayRoadConstraints([{ id: 'main', points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] }])
    constraints.updateExistingRoads([
      { id: 'access', points: [{ x: 200, y: -100 }, { x: 200, y: 0 }], width: 4, kind: 'local' },
      { id: 'motorway', points: [{ x: 400, y: -100 }, { x: 400, y: 100 }], width: 20, kind: 'arterial', level: 1, controlledAccess: true },
    ])
    expect(constraints.pathCost([{ x: 220, y: -100 }, { x: 220, y: 100 }], 'lane')).toBe(600)
    expect(constraints.pathCost([{ x: 420, y: -100 }, { x: 420, y: 100 }], 'lane')).toBe(600)
  })
  it('retains both inherited crossings even when their spacing predates the new policy', () => {
    const constraints = new RailwayRoadConstraints([{ id: 'main', points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] }])
    constraints.updateExistingRoads([200, 220].map(x => ({ id: `old-${x}`, points: [{ x, y: -100 }, { x, y: 100 }], width: 6, kind: 'local' as const })))
    for (const x of [200, 220]) {
      expect(constraints.pathCost([{ x, y: -100 }, { x, y: 100 }], 'lane')).toBe(600)
      expect(constraints.edgeCost({ x, y: -100 }, { x, y: 100 }, 'lane')).toBe(600)
    }
    expect(constraints.pathCost([{ x: 240, y: -100 }, { x: 240, y: 100 }], 'lane')).toBe(Infinity)
  })
  it('rejects a local road weaving across the same line and leaves subway streets unconstrained', () => {
    expect(railway.pathCost([{ x: 20, y: -20 }, { x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: -20 }], 'lane')).toBe(Infinity)
    const underground = new RailwayRoadConstraints([{ id: 'metro', mode: 'subway', points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] }])
    expect(underground.pathCost([{ x: 50, y: -50 }, { x: 50, y: 50 }], 'lane')).toBe(0)
    expect(underground.pathCost([{ x: 20, y: 0 }, { x: 200, y: 0 }], 'lane')).toBe(0)
  })
})
