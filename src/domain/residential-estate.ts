import type { Point } from './types'
import { corridorPolygon, distance, pointInPolygon, polygonArea, polygonsOverlap } from './geometry'
import { surveyDevelopmentSite } from './development-terrain'
import type { DevelopmentSiteSurvey, DevelopmentTerrain } from './development-terrain'

interface EstateSurvey {
  frontage: Point; along: Point; roadWidth: number; frontTitles: Point[][]
  terrain: DevelopmentTerrain
  canPlace(polygon: Point[]): boolean
  /** Already acquired titles, including separately owned rear gardens. */
  occupied(polygon: Point[]): boolean
  affordable(formation: DevelopmentSiteSurvey): boolean
}

/** A new, explicitly acquired residential holding, never an extension of an
 * existing title. Survey the deepest available option before falling back;
 * roads, water, owners and formation costs remain hard constraints.
 */
export function surveyResidentialEstate(input: EstateSurvey) {
  const { frontage, along, frontTitles, terrain } = input
  const normal = { x: -along.y, y: along.x }
  const sign = frontTitles.flat().reduce((sum, p) => sum + (p.x - frontage.x) * normal.x + (p.y - frontage.y) * normal.y, 0) >= 0 ? 1 : -1
  const local = (p: Point) => ({ x: (p.x - frontage.x) * along.x + (p.y - frontage.y) * along.y, y: ((p.x - frontage.x) * normal.x + (p.y - frontage.y) * normal.y) * sign })
  const world = (u: number, v: number): Point => ({ x: Math.round((frontage.x + u * along.x + v * normal.x * sign) * 10) / 10, y: Math.round((frontage.y + u * along.y + v * normal.y * sign) * 10) / 10 })
  const points = frontTitles.flat().map(local), u0 = Math.min(...points.map(p => p.x)), u1 = Math.max(...points.map(p => p.x)), v0 = Math.min(...points.map(p => p.y))
  if (u1 - u0 < 28 || u0 > -3 || u1 < 3) return null
  // The narrow entrance title reaches the existing road's2m reserved verge.
  // Its recorded path then runs only in that public ROW and this new holding.
  const entryDepth = input.roadWidth / 2 + 2.1
  for (const depth of [90, 80, 70]) {
    const far = v0 + depth
    const polygon = [world(u0, v0), world(-2, v0), world(-2, entryDepth), world(2, entryDepth), world(2, v0), world(u1, v0), world(u1, far), world(u0, far)]
    const area = polygonArea(polygon)
    if (area > 7200 || input.occupied(polygon) || !input.canPlace(polygon) || polygon.some(p => terrain.slope(p) > .12)) continue
    const left = u0 + 6, right = u1 - 6, rear = far - 8
    const footprint = right - left >= 30
      ? [world(right, v0 + 18), world(right, rear), world(left, rear), world(left, rear - 14), world(right - 14, rear - 14), world(right - 14, v0 + 18)]
      : [world(left, rear - 16), world(right, rear - 16), world(right, rear), world(left, rear)]
    if (!footprint.every(p => pointInPolygon(p, polygon)) || !input.canPlace(footprint)) continue
    const formation = surveyDevelopmentSite(terrain, footprint.reduce((sum, p) => ({ x: sum.x + p.x / footprint.length, y: sum.y + p.y / footprint.length }), { x: 0, y: 0 }), footprint)
    if (!formation.viable || formation.maximumFloors < 3 || !input.affordable(formation)) continue
    const approach = rear - (right - left >= 30 ? 17 : 19)
    const access = [frontage, world(0, v0 + 4), world(u0 + 3, v0 + 4), world(u0 + 3, approach), world(left + 5, approach)]
    let valid = true
    for (let i = 1; i < access.length && valid; i++) {
      // corridorPolygon includes square end caps: begin the private survey
      // one cap beyond the public verge, rather than falsely testing that
      // already-owned road surface as a new obstruction.
      const a = i === 1 ? world(0, entryDepth + 1.6) : access[i - 1]!, b = access[i]!, path = corridorPolygon(a, b, 1.5)
      if (!input.canPlace(path) || input.occupied(path) || polygonsOverlap(path, footprint)) { valid = false; break }
      const steps = Math.max(1, Math.ceil(distance(a, b) / 3))
      for (let j = 0; j <= steps; j++) {
        const p = { x: a.x + (b.x - a.x) * j / steps, y: a.y + (b.y - a.y) * j / steps }
        if (terrain.slope(p) > .12 || !pointInPolygon(p, polygon)) { valid = false; break }
      }
    }
    if (valid) return { polygon, footprint, formation, access, entrance: world(0, entryDepth), area, depth }
  }
  return null
}
