import { describe, expect, it } from 'vitest'
import { continuousLocalStreetDepth } from './continuous-city-density'
import { subdivideContinuousCityRoads } from './continuous-city-roads'
import type { ContinuousCityRoadInput } from './continuous-city-types'
import { distance, distanceToSegment, rectangle } from './geometry'

function fixture(intensity: number): ContinuousCityRoadInput {
  const width = 600, height = 500, center = { x: 300, y: 250 }
  return {
    config: { name: '住宅地の密度試験', seed: 'coherent-fringe-depth', type: 'newtown', terrain: 'plain', density: 100, forest: 0, railway: false, stations: 1, arterial: true, facilities: [], settlement: 'regional-city' },
    center, reservedRegions: [], railways: [],
    environment: { width, height, areas: [], core: null, terrain: { elevation: () => 10, slope: () => 0, waterAt: () => false, bridgeSites: [] } },
    initialRoads: [
      { id: 'existing-horizontal', kind: 'arterial', role: 'collector', width: 9, builtYear: 1900, points: [{ x: 0, y: 250 }, center, { x: 600, y: 250 }] },
      { id: 'existing-vertical', kind: 'arterial', role: 'collector', width: 9, builtYear: 1900, points: [{ x: 300, y: 0 }, center, { x: 300, y: 500 }] },
    ],
    demand: { center, regions: [{ polygon: rectangle(0, 0, width, height) }], at: p => p.x > 0 && p.y > 0 && p.x < width && p.y < height ? intensity : 0, costAt: () => 0, openingAt: () => 1955, metrics: { cellSize: 40, reachableLandArea: width * height, targetUrbanArea: width * height, selectedUrbanArea: width * height } },
  }
}

describe('continuous urban fringe density', () => {
  it('keeps central walking distances while increasing serviced holding depth continuously toward the fringe', () => {
    expect(continuousLocalStreetDepth(1)).toBe(20)
    expect(continuousLocalStreetDepth(.6)).toBeCloseTo(24.8)
    expect(continuousLocalStreetDepth(.15)).toBeGreaterThan(45)
    let previous = Infinity
    for (let i = 0; i <= 100; i++) {
      const current = continuousLocalStreetDepth(i / 100)
      expect(current).toBeLessThanOrEqual(previous)
      if (Number.isFinite(previous)) expect(previous - current).toBeLessThan(.7)
      previous = current
    }
  })

  it('builds a genuinely looser local network for a fringe neighbourhood while retaining dry street service', () => {
    const input = fixture(.15), before = JSON.stringify(input), fringe = subdivideContinuousCityRoads(input), core = subdivideContinuousCityRoads(fixture(.9))
    const newLength = (result: typeof fringe) => result.roads.filter(road => road.role === 'lane').reduce((sum, road) => sum + road.points.slice(1).reduce((n, p, i) => n + distance(road.points[i]!, p), 0), 0)
    expect(newLength(fringe)).toBeGreaterThan(0)
    expect(newLength(fringe)).toBeLessThan(newLength(core) * .9)
    let probes = 0, served = 0
    for (let y = 27; y < 500; y += 31) for (let x = 19; x < 600; x += 29) {
      probes++
      if (fringe.roads.some(road => road.points.slice(1).some((b, i) => distanceToSegment({ x, y }, road.points[i]!, b) < 65))) served++
    }
    expect(served / probes).toBeGreaterThan(.95)
    expect(JSON.stringify(input)).toBe(before)
  }, 5000)
})
