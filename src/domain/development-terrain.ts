import type { Point } from './types'

export interface DevelopmentTerrain { slope(point: Point): number; elevation?: (point: Point) => number }
export interface DevelopmentSiteSurvey {
  area: number; padRelief: number; cutVolume: number; fillVolume: number; retainingHeight: number
  formationCost: number; formationCostPerHousehold: number; suitability: number; viable: boolean; maximumFloors: number
}
const inside = (point: Point, polygon: Point[]) => {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

/** Ordinary lot formation, not a legal engineering approval or a calibrated
 * construction estimate. A balanced level pad purchases actual cut/fill and
 * retaining faces; a point's gentle slope cannot hide a cliff across the pad.
 * Larger engineered hillside estates are not silently assumed to exist. */
export function surveyDevelopmentSite(terrain: DevelopmentTerrain, point: Point, footprint?: Point[]): DevelopmentSiteSurvey {
  const polygon = footprint ?? [{ x: point.x - 7.5, y: point.y - 7.5 }, { x: point.x + 7.5, y: point.y - 7.5 }, { x: point.x + 7.5, y: point.y + 7.5 }, { x: point.x - 7.5, y: point.y + 7.5 }]
  const grade = terrain.slope(point), elevation = terrain.elevation ?? ((p: Point) => (p.x - point.x) * grade)
  const area = Math.abs(polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]!; return sum + a.x * b.y - a.y * b.x }, 0)) / 2
  const minX = Math.min(...polygon.map(p => p.x)), maxX = Math.max(...polygon.map(p => p.x)), minY = Math.min(...polygon.map(p => p.y)), maxY = Math.max(...polygon.map(p => p.y))
  const samples: number[] = []
  // Equal-area interior quadrature avoids treating all corner samples as an
  // equal share of earthwork. Boundary samples separately check the wall height.
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    const p = { x: minX + (x + .5) / 4 * (maxX - minX), y: minY + (y + .5) / 4 * (maxY - minY) }
    if (inside(p, polygon)) samples.push(elevation(p))
  }
  if (!samples.length) samples.push(elevation(point))
  const level = samples.reduce((sum, z) => sum + z, 0) / samples.length
  const boundary = polygon.flatMap((p, i) => { const q = polygon[(i + 1) % polygon.length]!; return [p, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }] })
  const heights = [...samples, ...boundary.map(elevation)], padRelief = Math.max(...heights) - Math.min(...heights)
  const cutVolume = samples.reduce((sum, z) => sum + Math.max(0, z - level), 0) / samples.length * area
  const fillVolume = samples.reduce((sum, z) => sum + Math.max(0, level - z), 0) / samples.length * area
  const retainingHeight = Math.max(...heights.map(z => Math.abs(z - level)))
  const perimeter = polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]!; return sum + Math.hypot(p.x - q.x, p.y - q.y) }, 0)
  // Relative credits: .08/m³ handled earth and .35/m² retaining face above
  // a small .3m foundation allowance. One reference household pad is225m².
  const formationCost = (cutVolume + fillVolume) * .08 + Math.max(0, retainingHeight - .3) * perimeter * .35
  const formationCostPerHousehold = formationCost * 225 / Math.max(1, area)
  const viable = Number.isFinite(formationCost) && grade <= .18 && retainingHeight <= 2 && (cutVolume + fillVolume) / Math.max(1, area) <= 1
  return { area, padRelief, cutVolume, fillVolume, retainingHeight, formationCost, formationCostPerHousehold, suitability: viable ? 1 / (1 + formationCostPerHousehold / 24) : 0, viable, maximumFloors: !viable ? 0 : padRelief <= 1.2 ? Infinity : padRelief <= 2.4 ? 4 : 2 }
}

/** Relative relief to an actual market/station, never an absolute-altitude ban.
 * This simple uphill round-trip impedance supplements network travel time.
 * Rates are explicit scenario assumptions, not an observed transport forecast. */
export function developmentClimbMinutes(point: Point, destination: Point, elevation: ((p: Point) => number) | undefined, year: number): number {
  if (!elevation) return 0
  return Math.abs(elevation(point) - elevation(destination)) / (year < 1900 ? 10 : year < 1950 ? 18 : 40)
}
