import type { Building, Facility, Parcel, Point, Road, TimelineVersion } from './types'
import { distance, projectPoint } from './geometry'

/** A shopping-street label follows an actual cluster of surviving shop
 * frontages. A future replacement building cannot create a historic label. */
export function shoppingStreetHistory(input: { buildings: TimelineVersion<Building>[]; parcels: TimelineVersion<Parcel>[]; roads: TimelineVersion<Road>[]; name: string; throughYear: number }): TimelineVersion<Facility>[] {
  const parcelRoads = new Map(input.parcels.map(version => [version.value.id, version.value.roadId]))
  const shops = input.buildings.filter(version => version.value.kind === 'commercial' && version.value.use !== 'lodging' && version.value.parcelId).map(version => ({ ...version, roadId: parcelRoads.get(version.value.parcelId!)!, point: version.value.polygon.reduce((sum, p) => ({ x: sum.x + p.x / version.value.polygon.length, y: sum.y + p.y / version.value.polygon.length }), { x: 0, y: 0 }) }))
  const years = [...new Set([1700, ...shops.flatMap(shop => [shop.from, ...(shop.to === undefined ? [] : [shop.to])]), ...input.roads.map(road => road.from)])].filter(year => year >= 1700 && year <= input.throughYear).sort((a, b) => a - b)
  const history: TimelineVersion<Facility>[] = []
  let previous: TimelineVersion<Facility> | undefined
  for (const year of years) {
    const roads = new Map(input.roads.filter(version => version.from <= year && (version.to === undefined || year < version.to)).map(version => [version.value.id, version.value]))
    const groups = new Map<string, Point[]>()
    for (const shop of shops) if (shop.from <= year && (shop.to === undefined || year < shop.to)) { const list = groups.get(shop.roadId) ?? []; list.push(shop.point); groups.set(shop.roadId, list) }
    let best: { point: Point; count: number } | undefined
    for (const [id, frontage] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const road = roads.get(id)
      if (!road || road.bridge || road.controlledAccess || ['expressway', 'ramp', 'farm'].includes(road.role ?? '')) continue
      for (const p of frontage) {
        const count = frontage.filter(q => distance(p, q) < 160).length
        if (count < 3 || best && count <= best.count) continue
        let nearest = p, separation = Infinity
        for (let i = 1; i < road.points.length; i++) { const q = projectPoint(p, road.points[i - 1]!, road.points[i]!), d = distance(p, q); if (d < separation) { nearest = q; separation = d } }
        best = { point: nearest, count }
      }
    }
    if (previous && best && distance(previous.value.point, best.point) < 1e-7 || !previous && !best) continue
    if (previous) previous.to = year
    previous = best ? { from: year, value: { id: 'facility-shop', kind: 'shop', point: best.point, name: input.name } } : undefined
    if (previous) history.push(previous)
  }
  return history
}
