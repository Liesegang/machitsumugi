import type { Area, Building, CityConfig, Facility, Point } from '../types'
import { contains, overlapsRegion, pointLineDistance } from './map-geometry'

/** Independent audit containment: split every building edge at every precinct
 * boundary intersection, then check each interval, including concave notches. */
function footprintInside(polygon: Point[], area: Area): boolean {
  const boundary = area.polygon
  const inside = (point: Point) => contains(boundary, point) || boundary.some((a, i) => pointLineDistance(point, a, boundary[(i + 1) % boundary.length]!) < 1e-8)
  if (polygon.length < 3 || !polygon.every(inside) || area.holes?.some(hole => overlapsRegion(polygon, { polygon: hole }))) return false
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, vx = b.x - a.x, vy = b.y - a.y, lengthSquared = vx * vx + vy * vy
    const cuts = [0, 1]
    for (let j = 0; j < boundary.length; j++) {
      const c = boundary[j]!, d = boundary[(j + 1) % boundary.length]!, ex = d.x - c.x, ey = d.y - c.y, denominator = vx * ey - vy * ex
      if (Math.abs(denominator) > 1e-10) {
        const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denominator, u = ((c.x - a.x) * vy - (c.y - a.y) * vx) / denominator
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t)
      } else if (lengthSquared && Math.abs(vx * (c.y - a.y) - vy * (c.x - a.x)) < 1e-8) {
        for (const point of [c, d]) {
          const t = ((point.x - a.x) * vx + (point.y - a.y) * vy) / lengthSquared
          if (t > 0 && t < 1) cuts.push(t)
        }
      }
    }
    cuts.sort((x, y) => x - y)
    for (let j = 1; j < cuts.length; j++) {
      const t = (cuts[j - 1]! + cuts[j]!) / 2
      if (!inside({ x: a.x + vx * t, y: a.y + vy * t })) return false
    }
  }
  return true
}

/** A shrine building may stand only in its own recorded religious precinct.
 * This never exempts water, forest, another park, or transport rights of way. */
export function ownReligiousPrecinct(building: Building, area: Area, map: { config: Pick<CityConfig, 'type'>; facilities: Pick<Facility, 'id' | 'kind'>[] }): boolean {
  if (area.kind !== 'park' || building.kind !== 'public') return false
  const prefix = 'facility-building-shrine'
  const ordinary = building.id.startsWith(prefix) && area.id === `facility-lot-shrine${building.id.slice(prefix.length)}`
  const origin = building.id === 'origin-shrine-building' && area.id === 'historic-core' && map.config.type === 'temple' && map.facilities.some(facility => facility.id === 'origin' && facility.kind === 'shrine')
  return (ordinary || origin) && footprintInside(building.polygon, area)
}
