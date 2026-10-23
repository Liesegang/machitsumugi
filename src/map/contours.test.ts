import { expect, it } from 'vitest'
import { terrainContours } from './contours'
it('interpolates an exact plane and joins the same elevation across cell boundaries', () => {
  const surface = { columns: 5, rows: 4, cellSize: 25, elevations: Array.from({ length: 20 }, (_, i) => i % 5 * 10 + Math.floor(i / 5) * 2) }
  const contours = terrainContours(surface)
  expect(contours.length).toBe(4)
  for (const line of contours) for (const p of line.points) expect(p.x * .4 + p.y * .08).toBeCloseTo(line.elevation, 8)
  expect(terrainContours(surface)).toBe(contours)
})
it('closes the summit rings without inventing negative or sea-floor contours', () => {
  const surface = { columns: 7, rows: 7, cellSize: 25, elevations: Array.from({ length: 49 }, (_, i) => 50 - Math.hypot(i % 7 - 3, Math.floor(i / 7) - 3) * 20) }
  const contours = terrainContours(surface)
  expect(contours.filter(line => line.points.length > 4)).not.toHaveLength(0)
  for (const line of contours) { expect(line.elevation).toBeGreaterThan(0); expect(line.points.at(-1)).toEqual(line.points[0]) }
})
