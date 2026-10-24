import { describe, expect, it } from 'vitest'
import { RoadPlanner } from './road-planner'

describe('exact hard site masks in a cached terrain planner', () => {
  it('keeps a valid entrance inside its title when the24m earthwork sample is outside', () => {
    const planner = new RoadPlanner({ width: 600, height: 600, areas: [], core: null, exactLandCost: true, landCost: p => p.x >= 140 && p.x <= 460 && p.y >= 170 && p.y <= 430 ? 0 : Infinity })
    expect(planner.cost([{ x: 300, y: 168 }, { x: 300, y: 169 }], 'access').cost).toBe(Infinity)
    const route = planner.plan({ x: 300, y: 173 }, { x: 300, y: 300 }, { role: 'access', width: 2.8, alignment: 'planned', maxNodes: 1800 })
    expect(route).not.toBeNull()
    expect(Number.isFinite(route!.cost)).toBe(true)
    expect(route!.points[0]).toEqual({ x: 300, y: 173 })
  })

  it('still refuses an actually blocked parcel boundary rather than clearing its infinity mask', () => {
    const planner = new RoadPlanner({ width: 600, height: 600, areas: [], core: null, exactLandCost: true, landCost: p => p.x > 270 && p.x < 330 ? Infinity : 0 })
    expect(planner.plan({ x: 150, y: 300 }, { x: 450, y: 300 }, { role: 'access', width: 2.8, alignment: 'planned', maxNodes: 1800 })).toBeNull()
  })
})
