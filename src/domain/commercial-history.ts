import type { Building, Facility, Parcel, Point, Road, TimelineVersion } from './types'
import { distance, projectPoint } from './geometry'

/** bridge=true describes a route which contains a crossing. Only a surveyed
 * crossing's chainage is unavailable for shop frontage; its dry approaches
 * remain ordinary public street. An unsurveyed bridge is still excluded. */
function commercialStreetSurvey(road: Road) {
  if (road.controlledAccess || ['expressway', 'ramp', 'farm'].includes(road.role ?? '')) return null
  const project = (point: Point) => {
    let nearest = point, separation = Infinity, at = 0, chainage = 0
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, p = projectPoint(point, a, b), d = distance(point, p)
      if (d < separation) { nearest = p; separation = d; at = chainage + distance(a, p) }
      chainage += distance(a, b)
    }
    return { point: nearest, separation, at }
  }
  const spans = road.surveyedBridgeSpans ?? [], intervals: { low: number; high: number }[] = []
  if ((road.bridge || road.role === 'bridge') && !spans.length) return null
  for (const span of spans) {
    if (![span.bankA.x, span.bankA.y, span.bankB.x, span.bankB.y].every(Number.isFinite)) return null
    const a = project(span.bankA), b = project(span.bankB)
    if (Math.max(a.separation, b.separation) > Math.max(.1, road.width / 2) || Math.abs(a.at - b.at) < .01) return null
    intervals.push({ low: Math.min(a.at, b.at) - .01, high: Math.max(a.at, b.at) + .01 })
  }
  const cache = new WeakMap<Point, Point | null>()
  return (point: Point) => {
    if (cache.has(point)) return cache.get(point)!
    const frontage = project(point), value = !Number.isFinite(frontage.separation) || intervals.some(span => frontage.at >= span.low && frontage.at <= span.high) ? null : frontage.point
    cache.set(point, value)
    return value
  }
}

/** A shopping-street label follows an actual cluster of surviving shop
 * frontages. A future replacement building cannot create a historic label. */
export function shoppingStreetHistory(input: { buildings: TimelineVersion<Building>[]; parcels: TimelineVersion<Parcel>[]; roads: TimelineVersion<Road>[]; name: string; throughYear: number }): TimelineVersion<Facility>[] {
  const parcelRoads = new Map(input.parcels.map(version => [version.value.id, version.value.roadId]))
  const shops = input.buildings.filter(version => version.value.kind === 'commercial' && version.value.use !== 'lodging' && version.value.parcelId).map(version => ({ ...version, roadId: parcelRoads.get(version.value.parcelId!)!, point: version.value.polygon.reduce((sum, p) => ({ x: sum.x + p.x / version.value.polygon.length, y: sum.y + p.y / version.value.polygon.length }), { x: 0, y: 0 }) }))
  const years = [...new Set([1700, ...shops.flatMap(shop => [shop.from, ...(shop.to === undefined ? [] : [shop.to])]), ...input.roads.map(road => road.from)])].filter(year => year >= 1700 && year <= input.throughYear).sort((a, b) => a - b)
  const history: TimelineVersion<Facility>[] = []
  const surveys = new WeakMap<Road, ReturnType<typeof commercialStreetSurvey>>()
  const streetSurvey = (road: Road) => {
    if (!surveys.has(road)) surveys.set(road, commercialStreetSurvey(road))
    return surveys.get(road)!
  }
  let previous: TimelineVersion<Facility> | undefined
  for (const year of years) {
    const roads = new Map(input.roads.filter(version => version.from <= year && (version.to === undefined || year < version.to)).map(version => [version.value.id, version.value]))
    const groups = new Map<string, Point[]>()
    for (const shop of shops) if (shop.from <= year && (shop.to === undefined || year < shop.to)) {
      const road = roads.get(shop.roadId), survey = road && streetSurvey(road)
      if (!survey?.(shop.point)) continue
      const list = groups.get(shop.roadId) ?? []; list.push(shop.point); groups.set(shop.roadId, list)
    }
    let best: { point: Point; count: number } | undefined
    for (const [id, frontage] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const road = roads.get(id)
      if (!road) continue
      const survey = streetSurvey(road)
      if (!survey) continue
      for (const p of frontage) {
        const count = frontage.filter(q => distance(p, q) < 160).length
        if (count < 3 || best && count <= best.count) continue
        const nearest = survey(p)
        if (nearest) best = { point: nearest, count }
      }
    }
    if (previous && best && distance(previous.value.point, best.point) < 1e-7 || !previous && !best) continue
    if (previous) previous.to = year
    previous = best ? { from: year, value: { id: 'facility-shop', kind: 'shop', point: best.point, name: input.name } } : undefined
    if (previous) history.push(previous)
  }
  return history
}
