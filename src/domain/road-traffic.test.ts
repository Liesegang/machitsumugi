import { describe, expect, it } from 'vitest'
import { assignRoadTraffic } from './road-traffic'
import type { Road } from './types'

const road = (id: string, pairs: number[][], width = 6): Road => ({ id, points: pairs.map(([x, y]) => ({ x: x!, y: y! })), width, role: 'lane', kind: 'local' })
describe('capacity-constrained road flow assignment', () => {
  it('conserves occupied-origin demand through the actual shared bridge and leaves unrelated streets unloaded', () => {
    const roads = [road('west', [[0, 100], [500, 100]]), { ...road('bridge', [[500, 100], [600, 100]]), bridge: true }, road('east', [[600, 100], [1000, 100]]), road('dead-end', [[600, 100], [600, 400]])]
    const before = JSON.stringify(roads), result = assignRoadTraffic({ roads, cells: [{ point: { x: 0, y: 100 }, households: 1000 }], destinations: [{ point: { x: 1000, y: 100 }, weight: 1 }], year: 2025 })
    expect(result.totalPeakTrips).toBeCloseTo(360)
    expect(result.unservedPeakTrips).toBe(0)
    expect(result.loads.get('bridge')!.peakVehicles).toBeCloseTo(360)
    expect(result.loads.get('dead-end')!.peakVehicles).toBe(0)
    expect(JSON.stringify(roads)).toBe(before)
  })

  it('keeps opposite banks separate inside one former spatial zone and sends west-bank households over the far bridge', () => {
    const input = {
      roads: [road('west', [[20, 0], [20, 600]]), { ...road('far-bridge', [[20, 600], [120, 600]]), bridge: true }, road('east', [[120, 600], [120, 0]])],
      // All three sites occupy the same old180m map box. Its household-weighted
      // centroid falls on the east bank and used to erase every west-bank trip.
      cells: [{ point: { x: 22, y: 80 }, households: 100 }, { point: { x: 22, y: 95 }, households: 50 }, { point: { x: 118, y: 80 }, households: 900 }],
      destinations: [{ point: { x: 120, y: 0 }, weight: 1 }], year: 2025,
    }
    const before = JSON.stringify(input), result = assignRoadTraffic(input)
    expect(result.origins).toBe(2) // The two west sites share only their own40m straight-road bin.
    expect(result.totalPeakTrips).toBeCloseTo(1050 * .36)
    expect(result.unservedPeakTrips).toBe(0)
    expect(result.loads.get('far-bridge')!.peakVehicles).toBeCloseTo(150 * .36)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('honours a recorded access road and keeps missing-road demand unserved rather than moving it to the other bank', () => {
    const roads = [road('west', [[20, 0], [20, 600]]), { ...road('far-bridge', [[20, 600], [120, 600]]), bridge: true }, road('east', [[120, 600], [120, 0]])]
    const result = assignRoadTraffic({ roads, cells: [
      { point: { x: 110, y: 80 }, households: 100, roadId: 'west' },
      { point: { x: 110, y: 80 }, households: 50, roadId: 'retired-access' },
    ], destinations: [{ point: { x: 120, y: 0 }, weight: 1 }], year: 2025 })
    expect(result.totalPeakTrips).toBeCloseTo(150 * .36)
    expect(result.unservedPeakTrips).toBeCloseTo(50 * .36)
    expect(result.loads.get('far-bridge')!.peakVehicles).toBeCloseTo(100 * .36)
  })

  it('reroutes some demand onto an available wider alternative when a narrow street fills up', () => {
    const roads = [road('narrow', [[0, 0], [800, 0]], 3.5), road('broad', [[0, 0], [0, 200], [800, 200], [800, 0]], 10)]
    const result = assignRoadTraffic({ roads, cells: [{ point: { x: 0, y: 0 }, households: 3000 }], destinations: [{ point: { x: 800, y: 0 }, weight: 1 }], year: 2025 })
    expect(result.unservedPeakTrips).toBe(0)
    expect(result.loads.get('broad')!.peakVehicles).toBeGreaterThan(0)
    expect(result.loads.get('narrow')!.peakVehicles).toBeLessThan(result.totalPeakTrips)
    expect(result.loads.get('narrow')!.loadedMinutes).toBeGreaterThan(result.loads.get('narrow')!.freeMinutes)
  })

  it('retains unmet trips to inaccessible destinations instead of erasing or reallocating them', () => {
    const roads = [road('street', [[0, 0], [100, 0]])]
    const cells = [{ point: { x: 0, y: 0 }, households: 1000 }]
    const missing = { point: { x: 1200, y: 0 }, weight: 1 }
    const none = assignRoadTraffic({ roads, cells, destinations: [missing], year: 2025 })
    expect(none.totalPeakTrips).toBeCloseTo(360)
    expect(none.unservedPeakTrips).toBeCloseTo(360)
    expect(none.loads.get('street')!.peakVehicles).toBe(0)
    const mixed = assignRoadTraffic({ roads, cells, destinations: [missing, { point: { x: 100, y: 0 }, weight: 1 }], year: 2025 })
    expect(mixed.totalPeakTrips).toBeCloseTo(360)
    expect(mixed.unservedPeakTrips).toBeGreaterThan(0)
    expect(mixed.loads.get('street')!.peakVehicles + mixed.unservedPeakTrips).toBeCloseTo(360)
  })

  it('does not invent a junction at a crossing on different levels or a controlled road entrance', () => {
    for (const controlled of [false, true]) {
      const roads = [road('local', [[0, 0], [100, 0]]), { ...road('other', [[100, 0], [100, 200]]), ...(controlled ? { role: 'expressway' as const, controlledAccess: true } : { level: 1 }) }, road('far', [[100, 200], [400, 200]])]
      const result = assignRoadTraffic({ roads, cells: [{ point: { x: 0, y: 0 }, households: 1000 }], destinations: [{ point: { x: 400, y: 200 }, weight: 1 }], year: 2025 })
      expect(result.unservedPeakTrips).toBeCloseTo(360)
      expect(result.loads.get('other')!.peakVehicles).toBe(0)
    }
  })

  it('keeps every household while aggregating only40m bins along one actual straight road', () => {
    const cells = Array.from({ length: 1200 }, (_, i) => ({ point: { x: i * 5, y: 0 }, households: i % 7 + 1 }))
    const result = assignRoadTraffic({ roads: [road('spine', [[0, 0], [6000, 0]], 13)], cells, destinations: [{ point: { x: 6000, y: 0 }, weight: 1 }], year: 2025 })
    expect(result.origins).toBe(150)
    expect(result.totalPeakTrips).toBeCloseTo(cells.reduce((n, c) => n + c.households, 0) * .36)
    expect(result.unservedPeakTrips).toBe(0)
    expect(Number.isFinite(result.travelTime({ x: 5, y: 0 }, { x: 5990, y: 0 }))).toBe(true)
  })

  it('charges congestion on partial-segment investment queries instead of bypassing it through a free-flow endpoint', () => {
    const roads = [road('bottleneck', [[0, 0], [1000, 0]], 4)]
    const result = assignRoadTraffic({ roads, cells: [{ point: { x: 0, y: 0 }, households: 1000 }], destinations: [{ point: { x: 1000, y: 0 }, weight: 1 }], year: 2025 })
    const load = result.loads.get('bottleneck')!
    expect(result.travelTime({ x: 250, y: 0 }, { x: 750, y: 0 })).toBeCloseTo(load.loadedMinutes / 2, 6)
    expect(result.travelTime({ x: 250, y: 0 }, { x: 750, y: 0 })).toBeGreaterThan(load.freeMinutes / 2)
  })

  it('appraises a widening using flow on each split edge without crediting an unloaded tail', () => {
    const assign = (tail: boolean) => assignRoadTraffic({
      roads: [road('bottleneck', tail ? [[0, 0], [100, 0], [1100, 0]] : [[0, 0], [100, 0]], 3.5)],
      cells: [{ point: { x: 0, y: 0 }, households: 1000 }], destinations: [{ point: { x: 100, y: 0 }, weight: 1 }], year: 2025,
    })
    const short = assign(false), tailed = assign(true)
    expect(tailed.loads.get('bottleneck')!.loadedMinutes).toBeGreaterThan(short.loads.get('bottleneck')!.loadedMinutes)
    const shortSaving = short.upgradeDailyVehicleMinutes('bottleneck', 6, 'lane')
    expect(shortSaving).toBeGreaterThan(0)
    expect(tailed.upgradeDailyVehicleMinutes('bottleneck', 6, 'lane')).toBeCloseTo(shortSaving, 8)
    expect(tailed.upgradeDailyVehicleMinutes('bottleneck', 3.5, 'lane')).toBe(0)
    expect(tailed.upgradeDailyVehicleMinutes('missing-road', 6, 'lane')).toBe(0)
  })
})
