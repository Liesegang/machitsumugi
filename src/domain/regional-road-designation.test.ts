import { describe, expect, it } from 'vitest'
import { regionalRoadKind } from './regional-road-planner'
import { roadTravelSpeed } from './road-graph'
import { roadTrafficCapacity } from './road-traffic'
import type { Road } from './types'

describe('regional road designation and physical cross-section', () => {
  it('retains a surveyed rural through road without inventing highway width or capacity', () => {
    for (const width of [4.5, 7]) {
      const road: Road = { id: 'surveyed-through', points: [{ x: -324, y: 100 }, { x: 400, y: 100 }], width, role: width < 5 ? 'lane' : 'collector', kind: 'local', boundaryContinuation: true }
      const designated = { ...road, kind: regionalRoadKind(true, road.boundaryContinuation, road.role!) }
      expect(designated.kind).toBe('arterial')
      expect(designated.points).toBe(road.points)
      expect(designated.width).toBe(width)
      expect(roadTravelSpeed(designated)).toBe(roadTravelSpeed(road))
      expect(roadTrafficCapacity(designated)).toBe(roadTrafficCapacity(road))
    }
  })

  it('does not turn local loops, farm tracks or private access into arterial routes', () => {
    expect(regionalRoadKind(false, true, 'highway')).toBe('local')
    expect(regionalRoadKind(true, false, 'collector')).toBe('local')
    expect(regionalRoadKind(true, undefined, 'lane')).toBe('local')
    expect(regionalRoadKind(true, true, 'access')).toBe('local')
    expect(regionalRoadKind(true, true, 'farm')).toBe('local')
  })
})
