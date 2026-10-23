import { describe, expect, it } from 'vitest'
import { planRailwayBranches } from './railway-network'
import type { RailwayPlan } from './railway-planner'
import type { Area } from './types'

const main: RailwayPlan = { points: Array.from({ length: 301 }, (_, i) => ({ x: 500, y: i * 10 })), elevations: new Array(301).fill(20), structures: [], diagnostics: { maxGroundGrade: 0, maxTrackGrade: 0, maxCurvature: 0, minCurveRadius: Infinity, maxEarthwork: 0, bridgeLength: 0, maxBridgeLength: 0 } }
const input = { width: 4000, height: 3000, main, terrain: { areas: [] as Area[], elevation: () => 20, waterAt: () => false }, hubs: [{ point: { x: 2000, y: 1500 }, demand: 2000, reason: '既存街道の市場集落' }], maxBranches: 2 }
describe('demand and geography led railway network', () => {
  it('serves a separated existing hub with an actual shared parent vertex', () => {
    const branches = planRailwayBranches(input)
    expect(branches).toHaveLength(1)
    const branch = branches[0]!
    expect(branch.points[0]).toBe(main.points[branch.parentIndex])
    expect(branch.elevations[0]).toBe(main.elevations[branch.parentIndex])
    expect(branch.constructionCost).toBeLessThan(branch.benefit)
    expect(branch.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
    expect(main.points.every(p => p.x === 500)).toBe(true)
  })
  it('does not invent a branch where demand is absent, access is already close, or no physical corridor exists', () => {
    expect(planRailwayBranches({ ...input, hubs: [{ ...input.hubs[0]!, demand: 0 }] })).toEqual([])
    expect(planRailwayBranches({ ...input, hubs: [{ ...input.hubs[0]!, point: { x: 650, y: 1500 } }] })).toEqual([])
    const sea: Area = { id: 'sea', kind: 'water', polygon: [{ x: 900, y: 0 }, { x: 1100, y: 0 }, { x: 1100, y: 3000 }, { x: 900, y: 3000 }] }
    expect(planRailwayBranches({ ...input, terrain: { ...input.terrain, areas: [sea], waterAt: p => p.x > 900 && p.x < 1100 } })).toEqual([])
  })
  it('rejects duplicate short city feeders and does not spend a covered hub demand on two branches', () => {
    const mainStationOptions = [[{ x: 500, y: 750 }, { x: 500, y: 1500 }, { x: 500, y: 2250 }], [{ x: 500, y: 1000 }, { x: 500, y: 2000 }], [{ x: 500, y: 1500 }]]
    expect(planRailwayBranches({ ...input, mainStationOptions, hubs: [{ point: { x: 1150, y: 1600 }, demand: 1600, reason: '本線駅から徒歩圏の旧市街' }, { point: { x: 1800, y: 2300 }, demand: 300, reason: '需要の小さい隣接農村' }] })).toEqual([])
    const branches = planRailwayBranches({ ...input, hubs: [input.hubs[0]!, { ...input.hubs[0]!, point: { x: 2150, y: 1650 } }] })
    expect(branches).toHaveLength(1)
  })
})
