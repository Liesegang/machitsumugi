import { describe, expect, it } from 'vitest'
import type { Area, Point } from './types'
import { RoadPlanner } from './road-planner'
import { simulateUrbanGrowth } from './urban-growth'

describe('harbor settlement origin', () => {
  it('starts with a physical local producer path when an island cannot reach regional map-edge terminals', () => {
    const land = [{ x: 650, y: 450 }, { x: 1350, y: 450 }, { x: 1350, y: 1150 }, { x: 650, y: 1150 }]
    const sea: Area = { id: 'sea-secondary', kind: 'water', polygon: [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 1600 }, { x: 0, y: 1600 }], holes: [land] }
    const waterAt = (p: Point) => p.x <= 650 || p.x >= 1350 || p.y <= 450 || p.y >= 1150
    const terrain = { elevation: (p: Point) => 5 + Math.max(0, 350 - Math.hypot(p.x - 1000, p.y - 800)) * .04, slope: () => .04, waterAt, bridgeSites: [] }
    const growth = simulateUrbanGrowth({ width: 2000, height: 1600, seed: 'island-fishing-landing', type: 'port', center: { x: 1000, y: 800 }, core: null, areas: [sea], arterial: true, railway: false, stationPoints: [], terrainModel: terrain, density: 0, era: 'historic' })
    expect(growth.roads.some(road => road.reason.includes('陸上生産集落'))).toBe(true)
    expect(growth.roads.every(road => road.builtYear === 1650)).toBe(true)
    const planner = new RoadPlanner({ width: 2000, height: 1600, areas: [sea], core: null, terrain })
    for (const road of growth.roads) expect(planner.validate(road.points, road.width)).toBe(true)
    expect(growth.centers[0]!.point.x).toBeGreaterThan(650)
    expect(growth.centers[0]!.point.x).toBeLessThan(1350)
    expect(growth.centers[0]!.point.y).toBeGreaterThan(450)
    expect(growth.centers[0]!.point.y).toBeLessThan(1150)
  })
})
