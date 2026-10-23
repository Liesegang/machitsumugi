import { describe, expect, it } from 'vitest'
import type { Area, Point } from './types'
import { RoadPlanner } from './road-planner'
import { RegionalRoadPlanner } from './regional-road-planner'
import { alignmentDiagnostics } from './road-alignment'
import { simulateUrbanGrowth } from './urban-growth'
import { planValleyThroughRoad, valleyBoundaryPortals } from './valley-through-road'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'

const width = 1800, height = 1400, origin = { x: 650, y: 650 }
const river = [{ x: 900, y: -600 }, { x: 900, y: 300 }, { x: 1050, y: 800 }, { x: 1050, y: 2000 }]
const riverArea: Area = { id: 'river', kind: 'water', polygon: river.map(p => ({ x: p.x - 22, y: p.y })).concat(river.slice().reverse().map(p => ({ x: p.x + 22, y: p.y }))) }
const inside = (p: Point, polygon: Point[]) => {
  let result = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result
  }
  return result
}
function fixture(blockDownstream = false, headInside = false, elevatedBridge = false) {
  const channel = headInside ? [{ x: 900, y: 158 }, ...river.slice(1)] : river
  const area = headInside ? { ...riverArea, polygon: channel.map(p => ({ x: p.x - 22, y: p.y })).concat(channel.slice().reverse().map(p => ({ x: p.x + 22, y: p.y }))) } : riverArea
  const tributary: Area = { id: 'surveyed-tributary', kind: 'water', polygon: [{ x: -500, y: 780 }, { x: width + 500, y: 780 }, { x: width + 500, y: 820 }, { x: -500, y: 820 }] }
  const waterAt = (p: Point) => inside(p, area.polygon) || (blockDownstream && p.y > height + 80 && p.y < height + 180) || (elevatedBridge && inside(p, tributary.polygon))
  const terrain = { elevation: (p: Point) => elevatedBridge ? waterAt(p) ? 0 : 100 : 30, slope: () => 0, waterAt, bridgeSites: elevatedBridge ? [{ x: 650, y: 800 }] : [] as Point[], bridgeCandidates: elevatedBridge ? [{ point: { x: 650, y: 800 }, bankA: { x: 650, y: 700 }, bankB: { x: 650, y: 900 }, width: 40, cost: 40 }] : [], rivers: [{ id: 'river', points: channel }] }
  const model = { ...terrain, continuationTerrain: terrain }
  const areas = elevatedBridge ? [area, tributary] : [area]
  const environment = { width, height, core: null, areas, terrain: model }
  const input = { width, height, center: origin, core: null, areas, seed: 'rural-valley-national-road', type: 'onsen' as const, density: 21, railway: false, stationPoints: [], settlement: 'village' as const, populationTrend: 'declining' as const, terrainModel: model }
  return { input, river: channel, planner: new RoadPlanner(environment), regionalPlanner: new RegionalRoadPlanner(environment) }
}

describe('regional through-road in a small mountain settlement', () => {
  it('funds one continuous modern national road independently of village population and the local historical lanes', () => {
    const { input, regionalPlanner } = fixture()
    const without = simulateUrbanGrowth({ ...input, arterial: false }), withRoad = simulateUrbanGrowth({ ...input, arterial: true })
    expect(withRoad.demandSchedule).toEqual(without.demandSchedule)
    expect(without.roads.some(road => road.role === 'highway')).toBe(false)
    expect(withRoad.roads.filter(road => road.builtYear < 1955).map(road => ({ id: road.id, role: road.role, width: road.width }))).toEqual(without.roads.filter(road => road.builtYear < 1955).map(road => ({ id: road.id, role: road.role, width: road.width })))
    const regional = withRoad.roads.filter(road => road.id.startsWith('regional-highway-1955'))
    expect(regional.length).toBeGreaterThan(0)
    const first = regional[0]!.points[0]!, last = regional.at(-1)!.points.at(-1)!
    const outside = (p: Point) => p.x < 0 || p.y < 0 || p.x > width || p.y > height
    expect(outside(first)).toBe(true)
    expect(outside(last)).toBe(true)
    expect(first.y).toBeLessThan(0)
    expect(last.y).toBeGreaterThan(height)
    for (const road of regional) {
      expect(road.kind).toBe('arterial')
      expect(road.width).toBe(8.5)
      expect(road.boundaryContinuation).toBe(true)
      expect(regionalPlanner.validate(road.points, road.width, road.bridge)).toBe(true)
      expect(road.reason).toContain('地域交通整備枠')
    }
    const points = regional.flatMap((road, i) => i ? road.points.slice(1) : road.points)
    expect(alignmentDiagnostics(points).minimumRadius).toBeGreaterThanOrEqual(85)
    expect(points.some(p => Math.hypot(p.x - origin.x, p.y - origin.y) < .01)).toBe(true)
    const cost = regional.reduce((sum, road) => sum + road.constructionCost, 0)
    expect(cost).toBeGreaterThan(0)
    expect(cost).toBeLessThanOrEqual((width + height) * 4)
  }, 30000)

  it('commits no partial national road when an outside water barrier has no surveyed crossing', () => {
    const { input, planner, regionalPlanner } = fixture(true)
    expect(regionalPlanner.plan(origin, { x: 650, y: -324 }, { role: 'highway', width: 8.5 })).not.toBeNull()
    expect(planValleyThroughRoad({ width, height, origin, river, planner, regionalPlanner })).toBeNull()
    const result = simulateUrbanGrowth({ ...input, arterial: true })
    expect(result.roads.some(road => road.id.startsWith('regional-highway-1955'))).toBe(false)
    expect(result.roads.some(road => road.role === 'highway')).toBe(false)
    expect(result.roads.length).toBeGreaterThan(0)
  }, 30000)

  it('surveys an engineering-checked land pass when the real source begins just inside the crop', () => {
    const { planner, regionalPlanner, river: headwater } = fixture(false, true), original = structuredClone(headwater)
    expect(headwater[0]!.y).toBeGreaterThan(28)
    const portals = valleyBoundaryPortals({ width, height, origin, river: headwater, roadWidth: 8.5, planner })
    expect(portals[0]!.length).toBeGreaterThan(0)
    expect(portals[0]!.every(point => point.y === 28)).toBe(true)
    const project = planValleyThroughRoad({ width, height, origin, river: headwater, planner, regionalPlanner })
    expect(project).not.toBeNull()
    expect(project!.headwaterPass).toBe(true)
    expect(project!.route.points[0]!.y).toBeLessThan(0)
    expect(regionalPlanner.validate(project!.route.points, project!.width)).toBe(true)
    expect(alignmentDiagnostics(project!.route.points).minimumRadius).toBeGreaterThanOrEqual(85)
    expect(headwater).toEqual(original)
  })

  it('accepts a level surveyed bridge above a lower river bed and preserves exact bank coordinates outside the regional planner', () => {
    const { planner, regionalPlanner, input } = fixture(false, false, true)
    const project = planValleyThroughRoad({ width, height, origin, river, planner, regionalPlanner })
    expect(project).not.toBeNull()
    expect(project!.route.surveyedBridgeSpans).toEqual([{ bankA: { x: 650, y: 700 }, bankB: { x: 650, y: 900 } }])
    const elevation = input.terrainModel.elevation
    expect(surveyedRoadGradeAllowed({ points: project!.route.points }, .10, elevation)).toBe(false)
    expect(surveyedRoadGradeAllowed(project!.route, .10, elevation)).toBe(true)
    expect(project!.sections.some(section => section.bridge)).toBe(true)
    for (const section of project!.sections) expect(regionalPlanner.validate(section.points, project!.width, section.bridge)).toBe(true)
  })
})
