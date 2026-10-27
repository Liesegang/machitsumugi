import { expect, it } from 'vitest'
import { distanceToSegment, polygonArea } from './geometry'
import { stationFootprint } from './station-footprint'
import type { CityConfig } from './types'

const config: CityConfig = { name: '試験市', seed: 'station-metric', type: 'post', terrain: 'plain', density: 80, forest: 0, railway: true, stations: 3, arterial: true, facilities: [], settlement: 'metropolis' }
it('follows the actual curve with both full-length metric platforms and rejects clipped ends', () => {
  const points = Array.from({ length: 101 }, (_, i) => ({ x: 300 + 400 * Math.sin((i - 50) / 100), y: 100 + i * 5 }))
  const chain = [0]; for (let i = 1; i < points.length; i++) chain.push(chain[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y))
  const common = { points, chain, side: 1, config, main: true }, footprint = stationFootprint({ ...common, along: chain[50]! })!
  expect(footprint.platforms).toHaveLength(2)
  expect(footprint.platforms.every(polygon => polygonArea(polygon) > 800)).toBe(true)
  for (const polygon of footprint.platforms) for (const point of polygon) {
    const distance = Math.min(...points.slice(1).map((b, i) => distanceToSegment(point, points[i]!, b)))
    expect(distance).toBeGreaterThan(3.95); expect(distance).toBeLessThan(8.05)
  }
  expect(stationFootprint({ ...common, along: 30 })).toBeUndefined()
  expect(stationFootprint({ ...common, along: chain.at(-1)! - 30 })).toBeUndefined()
})
