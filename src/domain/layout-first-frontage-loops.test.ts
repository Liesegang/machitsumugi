import { expect, it } from 'vitest'
import { layoutFrontageLoop } from './layout-first-frontage-loops'
import { distanceToSegment, polygonArea } from './geometry'
it('opens a closed town block from two real frontage points without a global frame', () => {
  const road = { id: 'old-road', kind: 'local' as const, width: 9, points: [{ x: 0, y: 0 }, { x: 2000, y: 0 }] }
  const points = layoutFrontageLoop(road, { x: 1000, y: 0 }, 912, 413, 1)
  expect(points).not.toBeNull()
  for (const point of [points![0]!, points!.at(-1)!]) expect(distanceToSegment(point, road.points[0]!, road.points[1]!)).toBeLessThan(1e-7)
  expect(polygonArea(points!)).toBeGreaterThan(200000)
})
