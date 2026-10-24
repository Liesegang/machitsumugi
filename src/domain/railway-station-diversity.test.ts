import { expect, it } from 'vitest'
import { planRailway } from './railway-planner'
import { railwayCorridors } from './railway-corridor'
import { rectangle } from './geometry'

it('surveys distinct terraces within the same nine-site budget instead of exhausting a clustered town-centre shortlist', () => {
  const hub = { x: 2100, y: 1900 }, width = 4000, height = 3000
  // A coastal market sits east of the regional corridor. Its closest station
  // sites need a very large lateral detour between the two inland exits.
  const areas = [
    { id: 'sea-north', kind: 'water' as const, polygon: rectangle(1000, -10, 3010, 110) },
    { id: 'sea-south', kind: 'water' as const, polygon: rectangle(1000, 2900, 3010, 110) },
    { id: 'sea-east', kind: 'water' as const, polygon: rectangle(3900, -10, 110, 3020) },
  ]
  const terrain = { areas, elevation: () => 20, slope: () => 0, waterAt: () => false }
  const input = { width, height, seed: 'coastal-market-terraces', origin: hub, terrain, settlements: [{ point: hub, demand: 3000 }] }
  const corridors = railwayCorridors(input)
  expect(corridors.length).toBeGreaterThan(0)
  const stations = [...new Map(corridors.map(corridor => [`${corridor.station.x}:${corridor.station.y}`, corridor.station])).values()]
  expect(stations.length).toBeLessThanOrEqual(9)
  expect(stations.some(station => Math.hypot(station.x - hub.x, station.y - hub.y) > 250)).toBe(true)
  const plan = planRailway(input)
  expect(plan).not.toBeNull()
  expect(plan!.terminus).toBeUndefined()
  expect(plan!.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
  expect(plan!.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
  expect(plan!.diagnostics.maxEarthwork).toBeLessThanOrEqual(12)
  expect(plan!.diagnostics.maxBridgeLength).toBeLessThanOrEqual(180)
})
