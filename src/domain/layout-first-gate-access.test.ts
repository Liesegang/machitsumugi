import { expect, it } from 'vitest'
import { RoadPlanner } from './road-planner'
import { rectangle, pointInRegion, corridorPolygon, polygonOverlapsRegion } from './geometry'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'
import { buildLayoutFirstRoads } from './layout-first-roads'

it('reaches a narrow reserved forecourt mouth from its surveyed arrival direction with the same finite search budget', () => {
  const reserves = [{ polygon: rectangle(395, 400, 200, 90) }, { polygon: rectangle(395, 490, 88, 50) }, { polygon: rectangle(507, 490, 88, 50) }]
  const terrain = { waterAt: () => false, slope: () => 0, elevation: () => 12, bridgeSites: [] }
  const planner = new RoadPlanner({ width: 1000, height: 900, areas: [], core: null, terrain, exactLandCost: true, landCost: point => reserves.some(region => pointInRegion(point, region)) ? Infinity : 0 })
  const start = { x: 200, y: 200 }, gate = { x: 495, y: 500 }, options = { role: 'access' as const, width: 6.5, allowBridge: true, alignment: 'planned' as const, maximumGrade: .13, maxNodes: 1600 }
  expect(planner.plan(start, gate, options)).toBeNull()
  const route = planner.plan(start, gate, { ...options, endHeading: -Math.PI / 2 })
  expect(route).not.toBeNull()
  expect(planner.validate(route!.points, 6.5, route!.bridgeLength > 0)).toBe(true)
  expect(planner.railwayWidthAllows(route!.points, .01, 5, 'access')).toBe(true)
  expect(surveyedRoadGradeAllowed(route!, .13, terrain.elevation)).toBe(true)
  for (let i = 1; i < route!.points.length; i++) for (const region of reserves) expect(polygonOverlapsRegion(corridorPolygon(route!.points[i - 1]!, route!.points[i]!, 3.25), region)).toBe(false)
})

it('leaves an ordinary valid same-era gate connection unchanged when arrival metadata is available', () => {
  const terrain = { waterAt: () => false, seaAt: () => false, slope: () => 0, elevation: () => 12 }
  const input = { environment: { width: 1000, height: 900, core: null, areas: [], terrain: { ...terrain, bridgeSites: [], continuationTerrain: terrain } }, seed: 'ordinary-gate-first', center: { x: 500, y: 200 }, zones: [] }
  const target = { id: 'station-access-fixture', point: { x: 300, y: 500 }, builtYear: 1900 }
  const ordinary = buildLayoutFirstRoads({ ...input, accessTargets: [target] })
  const withMouth = buildLayoutFirstRoads({ ...input, accessTargets: [{ ...target, endHeading: Math.PI }] })
  expect(ordinary.diagnostics.unservedAccessIds).toEqual([])
  expect(withMouth.diagnostics.unservedAccessIds).toEqual([])
  expect(withMouth.roads).toEqual(ordinary.roads)
  expect(withMouth.diagnostics.accessAttempts?.every(attempt => attempt.endHeading === undefined)).toBe(true)
  expect(withMouth.roads.filter(road => road.role === 'access').every(road => road.builtYear <= target.builtYear)).toBe(true)
})
