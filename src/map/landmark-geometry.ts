import { ShapeUtils, Vector2 } from 'three'
import type { Area, Building, CityMap, Point, Railway, Station } from '../domain/types'
import { distanceToSegment, pointInPolygon, polygonOverlapsRegion, polygonsOverlap, segmentsCross } from '../domain/geometry'

export interface ArchitecturePoint extends Point { elevation: number }
export interface ArchitectureTriangle { points: [ArchitecturePoint, ArchitecturePoint, ArchitecturePoint]; color: string }
export interface FootprintFrame { center: Point; along: Point; across: Point; length: number; depth: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
const at = (f: FootprintFrame, x: number, y: number, elevation: number): ArchitecturePoint => ({ x: f.center.x + f.along.x * x + f.across.x * y, y: f.center.y + f.along.y * x + f.across.y * y, elevation })
const rectangle = (f: FootprintFrame, length: number, depth: number, x = 0, y = 0) => [[-length / 2, -depth / 2], [length / 2, -depth / 2], [length / 2, depth / 2], [-length / 2, depth / 2]].map(([u, v]) => at(f, u! + x, v! + y, 0))

/** The surveyed long edge determines architectural direction, never map north. */
export function footprintFrame(polygon: Point[]): FootprintFrame | undefined {
  if (polygon.length < 3) return
  let along = { x: 1, y: 0 }, longest = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length > longest) { longest = length; along = { x: (b.x - a.x) / length, y: (b.y - a.y) / length } }
  }
  if (longest < .01) return
  const across = { x: -along.y, y: along.x }, us = polygon.map(p => dot(p, along)), vs = polygon.map(p => dot(p, across))
  const minU = Math.min(...us), maxU = Math.max(...us), minV = Math.min(...vs), maxV = Math.max(...vs)
  return { center: { x: along.x * (minU + maxU) / 2 + across.x * (minV + maxV) / 2, y: along.y * (minU + maxU) / 2 + across.y * (minV + maxV) / 2 }, along, across, length: maxU - minU, depth: maxV - minV }
}

class Architecture {
  triangles: ArchitectureTriangle[] = []
  triangle(a: ArchitecturePoint, b: ArchitecturePoint, c: ArchitecturePoint, color: string) { this.triangles.push({ points: [a, b, c], color }) }
  quad(a: ArchitecturePoint, b: ArchitecturePoint, c: ArchitecturePoint, d: ArchitecturePoint, color: string) { this.triangle(a, b, c, color); this.triangle(a, c, d, color) }
  cap(polygon: Point[], elevation: number, color: string) {
    for (const face of ShapeUtils.triangulateShape(polygon.map(p => new Vector2(p.x, p.y)), [])) this.triangle(...face.map(i => ({ ...polygon[i]!, elevation })) as [ArchitecturePoint, ArchitecturePoint, ArchitecturePoint], color)
  }
  prism(polygon: Point[], bottom: number, top: number, wall: string, roof = wall) {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!
      this.quad({ ...a, elevation: bottom }, { ...b, elevation: bottom }, { ...b, elevation: top }, { ...a, elevation: top }, wall)
    }
    this.cap(polygon, top, roof)
  }
  box(f: FootprintFrame, length: number, depth: number, bottom: number, top: number, wall: string, roof = wall, x = 0, y = 0) { this.prism(rectangle(f, length, depth, x, y), bottom, top, wall, roof) }
  /** Hipped tile roof with a curved lower pitch and a separate raised ridge. */
  hip(f: FootprintFrame, length: number, depth: number, eave: number, rise: number, color: string, curve = true) {
    const ridgeHalf = Math.max(0, length / 2 - depth * .55), eaves = rectangle(f, length, depth)
    const ridgeA = at(f, -ridgeHalf, 0, eave + rise), ridgeB = at(f, ridgeHalf, 0, eave + rise)
    for (let i = 0; i < 4; i++) {
      const a = { ...eaves[i]!, elevation: eave + (curve ? .16 : 0) }, b = { ...eaves[(i + 1) % 4]!, elevation: eave + (curve ? .16 : 0) }
      const apexA = i === 0 ? ridgeA : i === 1 ? ridgeB : i === 2 ? ridgeB : ridgeA
      const apexB = i === 0 ? ridgeB : i === 2 ? ridgeA : apexA
      const ma = { x: a.x * .7 + apexA.x * .3, y: a.y * .7 + apexA.y * .3, elevation: eave + rise * .18 }, mb = { x: b.x * .7 + apexB.x * .3, y: b.y * .7 + apexB.y * .3, elevation: eave + rise * .18 }
      this.quad(a, b, mb, ma, color)
      if (i % 2 === 0) this.quad(ma, mb, apexB, apexA, color)
      else this.triangle(ma, mb, apexA, color)
      // Dark eave fascia has its own depth; coplanar roof decals are avoided.
      this.quad({ ...a, elevation: eave - .18 }, { ...b, elevation: eave - .18 }, b, a, '#343d3b')
    }
    this.box(f, Math.max(.8, ridgeHalf * 2 + .3), .28, eave + rise, eave + rise + .28, '#59605a')
  }
  windows(polygon: Point[], bottom: number, floors: number, color = '#516a70', floorHeight = 3.2, historic = false) {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, length = Math.hypot(b.x - a.x, b.y - a.y)
      if (length < 4) continue
      const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length, count = Math.min(35, Math.floor((length - 1.2) / (historic ? 3.3 : 4.2))), width = Math.min(historic ? 1.1 : 2.4, length / Math.max(1, count) * .6)
      // Determine the exterior side independently of polygon winding.
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, sign = pointInPolygon({ x: mid.x - uy * .02, y: mid.y + ux * .02 }, polygon) ? -1 : 1
      const point = (u: number, elevation: number) => ({ x: a.x + ux * u - uy * .035 * sign, y: a.y + uy * u + ux * .035 * sign, elevation })
      for (let floor = 0; floor < Math.min(12, floors); floor++) for (let n = 0; n < count; n++) {
        const u = (n + .5) / count * length, low = bottom + floor * floorHeight + 1.05, high = Math.min(bottom + (floor + 1) * floorHeight - .45, low + (historic ? .85 : 1.35))
        this.quad(point(u - width / 2, low), point(u + width / 2, low), point(u + width / 2, high), point(u - width / 2, high), color)
      }
    }
  }
}

export function buildingArchitecture(building: Building, floor: number): ArchitectureTriangle[] | undefined {
  const f = footprintFrame(building.polygon)
  if (!f) return
  const model = new Architecture(), floors = clamp(building.height, 1, 40), top = floor + floors * 3.2, id = building.id
  if (/^castle-(?:small-)?keep$/.test(id)) {
    const stone = Math.min(4.5, f.depth * .16), lower = rectangle(f, f.length, f.depth), upper = rectangle(f, f.length * .86, f.depth * .86)
    for (let i = 0; i < 4; i++) model.quad({ ...lower[i]!, elevation: floor }, { ...lower[(i + 1) % 4]!, elevation: floor }, { ...upper[(i + 1) % 4]!, elevation: floor + stone }, { ...upper[i]!, elevation: floor + stone }, i % 2 ? '#8c8b7c' : '#9b9987')
    model.cap(upper, floor + stone, '#b7b19b')
    const tiers = clamp(Math.round(floors), 2, 5)
    for (let tier = 0; tier < tiers; tier++) {
      const scale = .84 * .79 ** tier, length = f.length * scale, depth = f.depth * scale, base = floor + stone + tier * 3.35, wallTop = base + 2.65
      const body = rectangle(f, length * .84, depth * .80)
      model.prism(body, base, wallTop, '#eee9d9', '#d6d1bd'); model.windows(body, base, 1, '#3d4848', 2.65, true)
      model.hip(f, length, depth, wallTop, Math.min(2.5, depth * .22), '#57615d')
    }
    return model.triangles
  }
  const traditional = id.startsWith('castle-') || id.includes('shrine') || id.includes('temple') || id.includes('onsen') || building.lodgingType === 'ryokan'
  const hospital = id.startsWith('facility-building-hospital'), school = id.startsWith('facility-building-school'), university = id.startsWith('facility-building-university'), port = id.startsWith('facility-building-port'), hotel = building.lodgingType === 'hotel'
  if (!traditional && !hospital && !school && !university && !port && !hotel && !id.startsWith('station-building-')) return
  const wall = traditional ? '#d9cfb4' : hospital ? '#dedfd4' : university && building.name?.includes('図書館') ? '#c5b79a' : school || university ? '#ddd4bd' : port ? '#b9c2bf' : '#c4c9c4'
  const rectangular = rectangle(f, f.length * .98, f.depth * .98).every(p => pointInPolygon(p, building.polygon)), body = traditional && rectangular ? rectangle(f, f.length * .82, f.depth * .74) : building.polygon
  model.prism(body, floor, top, wall, '#aeb8b0')
  model.windows(body, floor, floors, traditional ? '#66665c' : '#5c7981', 3.2, traditional)
  if (traditional && rectangular) {
    // Eaves project over an actual recessed timber facade and a low veranda.
    // The outer roof still fits wholly inside the surveyed building footprint.
    model.box(f, f.length * .94, f.depth * .89, floor, floor + .45, '#a8a18b', '#c0b495')
    const shrine = id.includes('shrine') || id.includes('temple'), timber = shrine ? '#9b6047' : '#83745b', posts = Math.max(3, Math.min(10, Math.floor(f.length / 6)))
    for (const side of [-1, 1]) {
      model.box(f, f.length * .86, .24, top - .4, top - .12, timber, timber, 0, side * f.depth * .39)
      for (let n = 0; n < posts; n++) model.box(f, .28, .28, floor + .45, top - .4, timber, timber, (n / (posts - 1) - .5) * f.length * .83, side * f.depth * .39)
    }
  }
  if (traditional || port || id.startsWith('station-building-')) {
    // Existing legacy facility footprints are rectangular. A concave footprint
    // keeps its surveyed flat roof rather than growing across its courtyard.
    const roof = rectangle(f, f.length * .98, f.depth * .98)
    if (roof.every(p => pointInPolygon(p, building.polygon))) model.hip(f, f.length, f.depth, top, Math.min(traditional ? 5 : 2.8, f.depth * .23), port ? '#81918a' : '#5b6460', !port)
  } else {
    const inset = rectangle(f, Math.max(2, f.length - 2), Math.max(2, f.depth - 2))
    // Low parapet around the actual outer perimeter, including an L-shaped school.
    for (let i = 0; i < building.polygon.length; i++) {
      const a = building.polygon[i]!, b = building.polygon[(i + 1) % building.polygon.length]!
      model.quad({ ...a, elevation: top }, { ...b, elevation: top }, { ...b, elevation: top + .5 }, { ...a, elevation: top + .5 }, '#e2dfd1')
    }
    if (inset.every(p => pointInPolygon(p, building.polygon))) {
      model.box(f, Math.min(13, f.length * .3), Math.min(8, f.depth * .25), top + .02, top + 2.4, '#b4bcb3', '#929e96')
      for (const x of [-.25, .25]) model.box(f, Math.min(5, f.length * .1), Math.min(3, f.depth * .1), top + .02, top + .8, '#899991', '#6d8079', f.length * x, f.depth * .2)
    }
  }
  return model.triangles
}

export function castleWallArchitecture(area: Area, elevation: (p: Point) => number): ArchitectureTriangle[] {
  if (!area.id.startsWith('castle-wall-')) return []
  const model = new Architecture(), floor = Math.max(...area.polygon.map(elevation)) + .12, top = floor + 4.2
  for (const ring of [area.polygon, ...area.holes ?? []]) for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    model.quad({ ...a, elevation: elevation(a) + .08 }, { ...b, elevation: elevation(b) + .08 }, { ...b, elevation: top }, { ...a, elevation: top }, i % 2 ? '#999988' : '#929481')
  }
  const polygon = area.polygon.map(p => new Vector2(p.x, p.y)), holes = (area.holes ?? []).map(ring => ring.map(p => new Vector2(p.x, p.y))), points = [area.polygon, ...area.holes ?? []].flat()
  for (const face of ShapeUtils.triangulateShape(polygon, holes)) model.triangle(...face.map(i => ({ ...points[i]!, elevation: top })) as [ArchitecturePoint, ArchitecturePoint, ArchitecturePoint], '#b6b19a')
  return model.triangles
}

type StationDetails = Station & { railwayId?: string; buildingPolygon?: Point[]; mode?: 'surface' | 'subway' }
type LineDetails = Railway & { mode?: 'surface' | 'subway' }
export interface StationArchitectureLayout { station: Station; line: Railway; frame: FootprintFrame; trackElevation: number; building?: Point[]; platforms: Point[][]; subway: boolean }

/** Legacy maps have no reserved station lot. Only a genuinely clear lot is
 * synthesized there; a busy footprint never gets a floating decorative house. */
export function stationArchitectureLayout(map: CityMap, station: StationDetails, elevation: (p: Point) => number): StationArchitectureLayout | undefined {
  let best: { line: LineDetails; a: Point; b: Point; i: number; t: number; distance: number } | undefined
  for (const line of map.railways as LineDetails[]) {
    if (station.railwayId && line.id !== station.railwayId) continue
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1]!, b = line.points[i]!, dx = b.x - a.x, dy = b.y - a.y, t = clamp(((station.point.x - a.x) * dx + (station.point.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1), d = distanceToSegment(station.point, a, b)
      if (!best || d < best.distance) best = { line, a, b, i, t, distance: d }
    }
  }
  if (!best || best.distance > 90) return
  const { line, a, b, i, t } = best, length = Math.hypot(b.x - a.x, b.y - a.y)
  if (length < .01) return
  const along = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }, across = { x: -along.y, y: along.x }, point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  const frame: FootprintFrame = { center: point, along, across, length: map.config.settlement === 'metropolis' ? 160 : map.config.settlement === 'regional-city' ? 110 : 65, depth: 12 }
  const subway = station.mode === 'subway' || line.mode === 'subway', trackElevation = line.elevations ? line.elevations[i - 1]! * (1 - t) + line.elevations[i]! * t : elevation(point)
  const clear = (polygon: Point[], railwayClearance = true) => {
    if (polygon.some(p => p.x < 0 || p.x > map.width || p.y < 0 || p.y > map.height)) return false
    if (map.areas.some(area => area.kind === 'water' && polygonOverlapsRegion(polygon, area))) return false
    if (map.buildings.some(building => polygonsOverlap(polygon, building.polygon))) return false
    for (const road of map.roads) for (let n = 1; n < road.points.length; n++) if (polygon.some((p, j) => distanceToSegment(p, road.points[n - 1]!, road.points[n]!) < road.width / 2 + .8 || segmentsCross(p, polygon[(j + 1) % polygon.length]!, road.points[n - 1]!, road.points[n]!)) || pointInPolygon(road.points[n]!, polygon)) return false
    if (railwayClearance) for (const route of map.railways as LineDetails[]) if (route.mode !== 'subway') for (let n = 1; n < route.points.length; n++) if (polygon.some(p => distanceToSegment(p, route.points[n - 1]!, route.points[n]!) < 3.2)) return false
    const levels = polygon.map(elevation)
    return Math.max(...levels) - Math.min(...levels) < (subway ? 1.5 : 2.5)
  }
  const building = station.buildingPolygon
  const platforms: Point[][] = []
  if (!subway && station.platformPolygons) platforms.push(...station.platformPolygons)
  // Older saved maps have no acquired platform geometry; retain their bounded
  // procedural fallback without replacing new surveyed decks at render time.
  if (!subway && !station.platformPolygons) for (const side of [-1, 1]) {
    let platformLength = frame.length
    while (platformLength >= 28) {
      const candidate = rectangle(frame, platformLength, 3.2, 0, side * 4.6)
      // A sharply curved legacy alignment cannot support a straight 160m deck.
      const cornersAtTrack = [-platformLength / 2, 0, platformLength / 2].map(x => at(frame, x, 0, 0))
      if (cornersAtTrack.every(p => line.points.some((q, n) => n && distanceToSegment(p, line.points[n - 1]!, q) < 1.1)) && clear(candidate, false)) { platforms.push(candidate); break }
      platformLength *= .72
    }
  }
  return { station, line, frame, trackElevation, building, platforms, subway }
}

export function stationArchitecture(layout: StationArchitectureLayout, elevation: (p: Point) => number): ArchitectureTriangle[] {
  const model = new Architecture(), { frame: f, trackElevation, building, platforms, subway } = layout
  if (building) {
    const base = Math.max(...building.map(elevation)) + .24, frame = footprintFrame(building)!
    if (subway) {
      model.prism(building, base, base + .18, '#a2aaa3')
      model.box(frame, frame.length, frame.depth, base + 2.35, base + 2.65, '#597c85', '#8ba8ac')
      for (const x of [-.44, .44]) for (const y of [-.4, .4]) model.box(frame, .12, .12, base, base + 2.35, '#677f80', '#677f80', frame.length * x, frame.depth * y)
      // Dark inset stair opening is above its backing, with no coplanar decal.
      model.box(frame, frame.length * .8, frame.depth * .7, base + .18, base + .2, '#344e55')
    } else {
      const floors = frame.length > 30 ? 2 : 1, roof = base + floors * 3.8
      model.prism(building, base, roof, '#e2d9c2', '#a9b0a4'); model.windows(building, base, floors, '#506b70', 3.8)
      model.hip(frame, frame.length, frame.depth, roof, Math.min(2.8, frame.depth * .22), '#5f706c')
      // Recessed ticket-hall glazing faces the platforms on the station side.
      const sign = dot({ x: frame.center.x - f.center.x, y: frame.center.y - f.center.y }, f.across) > 0 ? -1 : 1
      model.quad(at(frame, -frame.length * .24, sign * (frame.depth / 2 + .04), base + .3), at(frame, frame.length * .24, sign * (frame.depth / 2 + .04), base + .3), at(frame, frame.length * .24, sign * (frame.depth / 2 + .04), base + 2.8), at(frame, -frame.length * .24, sign * (frame.depth / 2 + .04), base + 2.8), '#375c67')
    }
  }
  for (const polygon of platforms) {
    const base = trackElevation + .75, deck = trackElevation + 1.35, canopy = deck + 3.15
    model.prism(polygon, base, deck, '#9d9d8d', '#d6d0b9')
    const count = polygon.length / 2
    const roofSections = polygon.length === 4 ? [polygon] : Array.from({ length: count - 1 }, (_, i) => [polygon[i]!, polygon[i + 1]!, polygon[polygon.length - 2 - i]!, polygon[polygon.length - 1 - i]!])
    for (const section of roofSections) {
      const pf = footprintFrame(section)!
      // Roof and columns follow the acquired deck, including curved platforms.
      const roofLength = pf.length * .72, roofDepth = pf.depth * .9
      model.box(pf, roofLength, roofDepth, canopy, canopy + .18, '#6d7c74', '#9eaaa0')
      const columns = Math.max(2, Math.floor(roofLength / 14))
      for (let i = 0; i < columns; i++) model.box(pf, .18, .18, deck, canopy, '#647366', '#647366', (i / (columns - 1) - .5) * (roofLength - 3))
      // Tactile paving is deliberately raised 2cm instead of sharing deck depth.
      const towardTrack = dot({ x: pf.center.x - f.center.x, y: pf.center.y - f.center.y }, pf.across) > 0 ? -1 : 1
      model.box(pf, pf.length * .97, .36, deck + .01, deck + .03, '#d9bf64', '#d9bf64', 0, towardTrack * (pf.depth / 2 - .45))
    }
  }
  if (!subway && platforms.length === 2 && building) {
    // A town stop has a modest footbridge; a tunnel station gets no surface span.
    const deck = trackElevation + 6.2, bridgeX = -Math.min(18, f.length * .18)
    model.box(f, 2.8, 12.4, deck, deck + .3, '#929f99', '#b8c2b6', bridgeX)
    model.box(f, 3.3, 12.6, deck + 2.3, deck + 2.55, '#788a80', '#a6b4a8', bridgeX)
    for (const side of [-1, 1]) {
      const pf = footprintFrame(platforms[side === -1 ? 0 : 1]!)!, start = trackElevation + 1.35
      for (let n = 0; n < 16; n++) {
        const x = bridgeX + 2.2 + n * .34, bottom = start + n / 16 * (deck - start)
        model.box(f, .36, 1.6, bottom, bottom + .32, '#b5bbae', '#d0d2c2', x, dot({ x: pf.center.x - f.center.x, y: pf.center.y - f.center.y }, f.across))
      }
      for (const x of [-1, 1]) model.box(f, .14, .14, deck + .3, deck + 2.3, '#677d70', '#677d70', bridgeX + x * 1.25, side * 5.5)
    }
  }
  return model.triangles
}
