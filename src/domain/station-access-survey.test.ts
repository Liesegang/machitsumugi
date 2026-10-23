import { describe, expect, it } from 'vitest'
import { stationAccess } from './station-access-survey'
import type { StationAccessSurvey } from './station-access-survey'
import { RoadPlanner } from './road-planner'
import type { Road } from './types'

describe('station approaches across the railway acquisition corridor', () => {
  it('skips a nearer street whose direct approach occupies the track and uses an affordable perpendicular street', () => {
    const planner = new RoadPlanner({ width: 1000, height: 600, areas: [], core: null })
    planner.setRailwayCorridors([{ id: 'main', points: [{ x: 0, y: 300 }, { x: 1000, y: 300 }] }])
    const roads: Road[] = [
      { id: 'nearest', kind: 'local', role: 'lane', width: 4, points: [{ x: 450, y: 299 }, { x: 450, y: 301 }] },
      { id: 'forecourt-street', kind: 'local', role: 'lane', width: 4, points: [{ x: 400, y: 450 }, { x: 600, y: 450 }] },
    ]
    const station = { x: 500, y: 300 }
    expect(planner.validate([{ x: 450, y: 300 }, station], 4)).toBe(true)
    expect(planner.cost([{ x: 450, y: 300 }, station], 'access').cost).toBe(Infinity)
    const survey: StationAccessSurvey = { planner, roads, routes: new Map(), rejected: [], attempts: 0 }
    const route = stationAccess(station, survey)
    expect(route).not.toBeNull()
    expect(route!.cost).toBeGreaterThan(0)
    expect(Number.isFinite(route!.cost)).toBe(true)
    expect(route!.points[0]).toEqual({ x: 500, y: 450 })
    expect(route!.points.at(-1)).toEqual(station)
    expect(stationAccess(station, survey)).toBe(route)
  })
})
