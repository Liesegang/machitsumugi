import type { Point, Road } from './types'
import { distance, distanceToSegment, pointInPolygon, polygonArea, segmentsCross } from './geometry'

export interface LayoutNeighborhoodSite { id: string; point: Point; builtYear: number }
export interface LayoutNeighborhoodAnchor { point: Point; roadId: string; builtYear: number }
export interface LayoutNeighborhoodLink {
  from: LayoutNeighborhoodAnchor
  to: LayoutNeighborhoodAnchor
  builtYear: number
  width: number
  siteIds: [string, string]
}
interface Sample extends LayoutNeighborhoodAnchor { tangent: number; throughRouteId?: string }
interface Segment { a: Point; b: Point; width: number }

/** Real closed frontage near a public hub makes a stamped outer loop
 * unnecessary. This measures access to existing faces, not a circular town
 * boundary or a desired amount of painted urban land. */
export function layoutNeighborhoodHasStreetFace(site: LayoutNeighborhoodSite, faces: readonly Point[][]): boolean {
  const nearby = faces.filter(polygon => polygonArea(polygon) > 2500 && (pointInPolygon(site.point, polygon) || polygon.some((a, i) => distanceToSegment(site.point, a, polygon[(i + 1) % polygon.length]!) < 150)))
  // A distant edge or the needle tip of one closed triangle does not provide
  // a neighbourhood's street frontage. Check that real enclosed land reaches
  // several street-sized directions around the hub. These are diagnostic
  // probes, never a circular/square boundary supplied to street construction.
  let supported = 0
  for (const dx of [-80, 0, 80]) for (const dy of [-80, 0, 80]) {
    if (!dx && !dy) continue
    if (nearby.some(polygon => pointInPolygon({ x: site.point.x + dx, y: site.point.y + dy }, polygon))) supported++
  }
  return supported >= 2
}

/** Propose local rungs between actual nearby public roads. Several separated
 * contacts can close the land BETWEEN neighbourhoods, instead of surrounding
 * every neighbourhood with its own completed capsule. There is no city grid,
 * centre-point mesh, implied land acquisition or physical acceptance here. */
export function proposeLayoutNeighborhoodLinks(input: {
  roads: readonly Road[]
  sites: readonly LayoutNeighborhoodSite[]
  maximumLinkLength?: number
  maximumLinksPerPair?: number
}): LayoutNeighborhoodLink[] {
  const maximumLength = input.maximumLinkLength ?? 1200, maximumPerPair = input.maximumLinksPerPair ?? 3
  const sites = [...input.sites].sort((a, b) => a.id.localeCompare(b.id)), anchors = new Map(sites.map(site => [site.id, [] as Sample[]]))
  const publicRoads = input.roads.filter(road => !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp' && (road.level ?? 0) === 0 && !road.bridge && road.width >= 4.6 && road.points.length >= 2)
  const bins = new Map<string, Segment[]>()
  const keys = (a: Point, b: Point, pad = 0) => {
    const result: string[] = []
    for (let x = Math.floor((Math.min(a.x, b.x) - pad) / 120); x <= Math.floor((Math.max(a.x, b.x) + pad) / 120); x++) for (let y = Math.floor((Math.min(a.y, b.y) - pad) / 120); y <= Math.floor((Math.max(a.y, b.y) + pad) / 120); y++) result.push(`${x}:${y}`)
    return result
  }
  const addSample = (point: Point, road: Road, tangent: number) => {
    const owner = sites.reduce<LayoutNeighborhoodSite | undefined>((best, site) => !best || distance(point, site.point) < distance(point, best.point) ? site : best, undefined)
    if (!owner || distance(point, owner.point) > 850) return
    const list = anchors.get(owner.id)!
    if (!list.some(sample => sample.roadId === road.id && distance(point, sample.point) < 25)) list.push({ point, roadId: road.id, builtYear: road.builtYear ?? 1650, tangent, throughRouteId: road.throughRouteId })
  }
  for (const road of publicRoads) {
    let chainage = 0, next = 0
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, length = distance(a, b)
      if (length < 1e-8) continue
      const segment = { a, b, width: road.width }, tangent = Math.atan2(b.y - a.y, b.x - a.x)
      for (const key of keys(a, b, road.width / 2 + 4)) { const list = bins.get(key) ?? []; list.push(segment); bins.set(key, list) }
      for (; next <= chainage + length; next += 80) {
        const t = Math.max(0, Math.min(1, (next - chainage) / length))
        addSample({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, road, tangent)
      }
      if (i === road.points.length - 1) addSample({ ...b }, road, tangent)
      chainage += length
    }
  }
  for (const site of sites) anchors.set(site.id, anchors.get(site.id)!.sort((a, b) => distance(a.point, site.point) - distance(b.point, site.point)).slice(0, 96))
  const covered = (point: Point) => keys(point, point, 20).some(key => (bins.get(key) ?? []).some(segment => distanceToSegment(point, segment.a, segment.b) < segment.width / 2 + 3))
  type Pair = { a: LayoutNeighborhoodSite; b: LayoutNeighborhoodSite; candidates: { from: Sample; to: Sample; length: number; score: number; middle: Point }[] }
  const pairs: Pair[] = []
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
    const a = sites[i]!, b = sites[j]!
    if (distance(a.point, b.point) > maximumLength + 1400 || distance(a.point, b.point) < 120) continue
    const candidates: Pair['candidates'] = []
    for (const from of anchors.get(a.id)!) for (const to of anchors.get(b.id)!) {
      if (from.roadId === to.roadId || from.throughRouteId && from.throughRouteId === to.throughRouteId) continue
      const length = distance(from.point, to.point)
      if (length < 90 || length > maximumLength) continue
      const bearing = Math.atan2(to.point.y - from.point.y, to.point.x - from.point.x)
      const firstAngle = Math.asin(Math.min(1, Math.abs(Math.sin(bearing - from.tangent)))), lastAngle = Math.asin(Math.min(1, Math.abs(Math.sin(bearing - to.tangent))))
      if (Math.min(firstAngle, lastAngle) < Math.PI * 35 / 180) continue
      const middle = { x: (from.point.x + to.point.x) / 2, y: (from.point.y + to.point.y) / 2 }
      if (covered(middle)) continue
      const score = length + (distance(from.point, a.point) + distance(to.point, b.point)) * .12 + (Math.PI - firstAngle - lastAngle) * 35
      candidates.push({ from, to, length, score, middle })
    }
    candidates.sort((a, b) => a.score - b.score || a.from.roadId.localeCompare(b.from.roadId) || a.to.roadId.localeCompare(b.to.roadId))
    if (candidates.length) pairs.push({ a, b, candidates })
  }
  pairs.sort((a, b) => a.candidates[0]!.score - b.candidates[0]!.score || a.a.id.localeCompare(b.a.id))
  const result: LayoutNeighborhoodLink[] = [], neighbours = new Map<string, number>()
  for (const pair of pairs) {
    if ((neighbours.get(pair.a.id) ?? 0) >= 2 || (neighbours.get(pair.b.id) ?? 0) >= 2) continue
    const selected: Pair['candidates'] = []
    for (const candidate of pair.candidates) {
      // Each rung uses a distinct reach on BOTH physical roads. Three almost
      // coincident shortcuts cannot substitute for several real town blocks.
      if (selected.some(other => distance(candidate.from.point, other.from.point) < 150 || distance(candidate.to.point, other.to.point) < 150 || distance(candidate.middle, other.middle) < 180 || segmentsCross(candidate.from.point, candidate.to.point, other.from.point, other.to.point))) continue
      selected.push(candidate)
      if (selected.length >= maximumPerPair) break
    }
    if (selected.length < 2) continue
    neighbours.set(pair.a.id, (neighbours.get(pair.a.id) ?? 0) + 1); neighbours.set(pair.b.id, (neighbours.get(pair.b.id) ?? 0) + 1)
    for (const candidate of selected) result.push({ from: { point: candidate.from.point, roadId: candidate.from.roadId, builtYear: candidate.from.builtYear }, to: { point: candidate.to.point, roadId: candidate.to.roadId, builtYear: candidate.to.builtYear },
      builtYear: Math.max(pair.a.builtYear, pair.b.builtYear, candidate.from.builtYear, candidate.to.builtYear), width: 7, siteIds: [pair.a.id, pair.b.id] })
  }
  return result
}
