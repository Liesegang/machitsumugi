import type { Point, Road, Station } from './types'
import { distance, distanceToSegment } from './geometry'
import { surveyDevelopmentSite } from './development-terrain'
import type { DevelopmentTerrain, DevelopmentSiteSurvey } from './development-terrain'
export interface ZonePolicy { kind: 'historic-mixed' | 'station-centre' | 'roadside-mixed' | 'industrial' | 'residential-low' | 'residential-mid' | 'onsen-mixed'; retailShare: number; apartmentShare: number; maximumFloors: number; industrialShare: number }
/** Planning districts use inherited centres, active infrastructure and access.
 * These are fictional planning policies, not statutory Japanese zoning data.
 * Each district permits a mix; neighbouring lots do not all become one use. */
export function createUrbanZoning(input: { roads: Road[]; stations: Station[]; center: Point; thermalCenter?: Point; metropolitan?: boolean; centers?: { point: Point; kind?: string; activeYear: number; catchment: number }[]; terrain?: DevelopmentTerrain }) {
  const sites = new Map<string, DevelopmentSiteSurvey>()
  // Fictional walking catchments: 75m/min on the plan plus 10m/min ascent.
  // A high basin with its own station remains as accessible as a low basin.
  const walkingDistance = (a: Point, b: Point) => distance(a, b) + (input.terrain?.elevation ? Math.abs(input.terrain.elevation(a) - input.terrain.elevation(b)) * 7.5 : 0)
  const policyAt = (point: Point, year: number): ZonePolicy => {
    const metro = !!input.metropolitan
    const station = year < 1900 || !input.stations.length ? Infinity : Math.min(...input.stations.map(s => walkingDistance(s.point, point)))
    const industrial = input.centers?.some(c => c.kind === 'industrial' && c.activeYear <= year && walkingDistance(c.point, point) < c.catchment * .8)
    const arterial = input.roads.some(r => (r.builtYear ?? 1650) <= year && r.kind === 'arterial' && !r.controlledAccess && r.role !== 'expressway' && r.role !== 'ramp' && r.points.some((p, i) => i > 0 && distanceToSegment(point, r.points[i - 1]!, p) < 65))
    if (input.thermalCenter && walkingDistance(point, input.thermalCenter) < 650) return { kind: 'onsen-mixed', retailShare: .32, apartmentShare: year < 1955 ? 0 : .05, maximumFloors: year < 1955 ? 3 : 7, industrialShare: .005 }
    if (industrial) return { kind: 'industrial', retailShare: .08, apartmentShare: .03, maximumFloors: 3, industrialShare: .78 }
    if (station < (year < 1955 ? 230 : metro ? 600 : 360)) return { kind: 'station-centre', retailShare: .66, apartmentShare: year < 1955 ? 0 : .65, maximumFloors: year < 1955 ? 4 : metro ? 18 : 8, industrialShare: .02 }
    if (walkingDistance(point, input.center) < 420) return { kind: 'historic-mixed', retailShare: .47, apartmentShare: year < 1955 ? 0 : .18, maximumFloors: year < 1955 ? 3 : metro ? 7 : 4, industrialShare: .04 }
    if (arterial) return { kind: 'roadside-mixed', retailShare: year < 1955 ? .30 : .48, apartmentShare: year < 1955 ? 0 : .22, maximumFloors: year < 1955 ? 3 : metro ? 8 : 5, industrialShare: .10 }
    if (year >= 1955 && station < (metro ? 1400 : 800)) return { kind: 'residential-mid', retailShare: .06, apartmentShare: metro ? .52 : .24, maximumFloors: metro ? 10 : 5, industrialShare: .01 }
    return { kind: 'residential-low', retailShare: .025, apartmentShare: year < 1955 ? 0 : .035, maximumFloors: 3, industrialShare: .01 }
  }
  return (point: Point, year: number): ZonePolicy => {
    const policy = policyAt(point, year)
    if (!input.terrain) return policy
    const key = `${point.x}:${point.y}`
    let site = sites.get(key)
    if (!site) { site = surveyDevelopmentSite(input.terrain, point); sites.set(key, site) }
    return { ...policy, maximumFloors: Math.min(policy.maximumFloors, site.maximumFloors), apartmentShare: policy.apartmentShare * site.suitability, industrialShare: policy.industrialShare * site.suitability ** 2 }
  }
}
