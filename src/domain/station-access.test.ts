import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, generateCity } from './generator'
import { distance, distanceToSegment } from './geometry'
import { createTerrainModel } from './terrain'

describe('coastal station access', () => {
  it('retains all requested stations on the railway with exact physical street junctions', () => {
    const config = { ...DEFAULT_CONFIG, type: 'port' as const, terrain: 'coast' as const, facilities: [...DEFAULT_CONFIG.facilities.filter(kind => kind !== 'castle'), 'port' as const] }
    const map = generateCity(config)
    const terrain = createTerrainModel({ width: map.width, height: map.height, ...config })
    expect(map.stations).toHaveLength(config.stations)
    for (const rail of map.railways) for (const end of [rail.points[0]!, rail.points.at(-1)!]) {
      // A city-side terminus serves the destination itself. Track should not
      // continue into empty land after the final passenger platform.
      if (end.x > 20 && end.y > 20 && end.x < map.width - 20 && end.y < map.height - 20) expect(map.stations.some(station => distance(station.point, end) < 1e-7)).toBe(true)
    }
    for (const station of map.stations) {
      expect(terrain.slope(station.point)).toBeLessThanOrEqual(.14)
      expect(Math.min(...map.railways.flatMap(rail => rail.points.slice(1).map((b, i) => distanceToSegment(station.point, rail.points[i]!, b))))).toBeLessThan(1e-7)
      expect(Math.min(...map.roads.flatMap(road => road.points.map(point => distance(point, station.point))))).toBeLessThan(1e-7)
      const access = map.roads.find(road => road.points.some(point => distance(point, station.point) < 1e-7))
      expect(access!.builtYear).toBeGreaterThanOrEqual(1900)
    }
  }, 600000)
})
