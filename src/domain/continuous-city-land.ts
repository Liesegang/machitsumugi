import type { Area, Building, BuildingState, GrowthEvent, Parcel, Point, Road, TimelineVersion } from './types'
import type { Bounds, PolygonRegion } from './geometry'
import type { ContinuousCityLandInput } from './continuous-city-types'
import { boundsOf, corridorPolygon, distance, distanceToSegment, intersectRegions, overlaps, pointInPolygon, pointInRegion, polygonArea, polygonOverlapsRegion, projectPoint, rectangle, regionArea, seededRandom, segmentsCross, subtractRegions } from './geometry'
import { buildingServiceYears } from './building-lifecycle'

interface Segment { a: Point; b: Point; road: Road; polygon: Point[]; bounds: Bounds }
interface Frontage { a: Point; b: Point; segment: Segment; length: number }
interface Cell extends PolygonRegion { frontages: Frontage[] }
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))
const publicStreet = (road: Road) => !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp' && road.role !== 'farm' && (road.level ?? 0) === 0
const sumArea = (regions: readonly PolygonRegion[]) => regions.reduce((sum, region) => sum + regionArea(region), 0)
const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const onBoundary = (p: Point, polygon: Point[]) => polygon.some((a, i) => distanceToSegment(p, a, polygon[(i + 1) % polygon.length]!) < .0005)
const within = (p: Point, region: PolygonRegion) => (pointInPolygon(p, region.polygon) || onBoundary(p, region.polygon)) && !(region.holes ?? []).some(hole => pointInPolygon(p, hole))
function interior(region: PolygonRegion): Point {
  const bounds = boundsOf(region.polygon), center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  if (pointInRegion(center, region)) return center
  for (const fraction of [.25, .5, .75, .125, .875]) for (let i = 1; i < 8; i++) {
    const p = { x: bounds.minX + (bounds.maxX - bounds.minX) * fraction, y: bounds.minY + (bounds.maxY - bounds.minY) * i / 8 }
    if (pointInRegion(p, region)) return p
  }
  return middle(region.polygon[0]!, region.polygon[1]!)
}
function samples(polygon: Point[], spacing = 4): Point[] {
  return polygon.flatMap((a, i) => { const b = polygon[(i + 1) % polygon.length]!, count = Math.max(1, Math.ceil(distance(a, b) / spacing)); return Array.from({ length: count }, (_, n) => ({ x: a.x + (b.x - a.x) * n / count, y: a.y + (b.y - a.y) * n / count })) })
}
function containsPolygon(region: PolygonRegion, polygon: Point[]) {
  return polygon.every(p => within(p, region)) && !polygon.some((a, i) => [region.polygon, ...region.holes ?? []].some(ring => ring.some((b, j) => segmentsCross(a, polygon[(i + 1) % polygon.length]!, b, ring[(j + 1) % ring.length]!)))) && !(region.holes ?? []).some(hole => hole.some(p => pointInPolygon(p, polygon)))
}
function spatialIndex<T extends { bounds: Bounds }>(size = 80) {
  const bins = new Map<string, T[]>()
  const keys = function* (b: Bounds) { for (let x = Math.floor(b.minX / size); x <= Math.floor(b.maxX / size); x++) for (let y = Math.floor(b.minY / size); y <= Math.floor(b.maxY / size); y++) yield `${x}:${y}` }
  return {
    add(value: T) { for (const key of keys(value.bounds)) { const list = bins.get(key) ?? []; list.push(value); bins.set(key, list) } },
    query(bounds: Bounds) { const result = new Set<T>(); for (const key of keys(bounds)) for (const value of bins.get(key) ?? []) if (overlaps(bounds, value.bounds)) result.add(value); return [...result] },
  }
}

/** A block cadastre, rather than independent rectangles cast from each road.
 * Every developable square metre becomes a title, a surveyed shared street or
 * an explicitly identified open-space remainder. Physical masks are immutable. */
export function developContinuousCityLand(input: ContinuousCityLandInput) {
  const endYear = clamp(Math.round(input.config.targetYear ?? 2025), 1650, 2025)
  const roadIndex = spatialIndex<Segment>(), obstacleIndex = spatialIndex<PolygonRegion & { bounds: Bounds }>()
  const addRoad = (road: Road) => {
    if ((road.level ?? 0) !== 0) return
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!
      if (distance(a, b) < .01) continue
      const polygon = corridorPolygon(a, b, road.width / 2 + .25)
      roadIndex.add({ a, b, road, polygon, bounds: boundsOf(polygon) })
    }
  }
  for (const road of input.roads) addRoad(road)
  for (const region of [...input.terrain.areas.filter(area => area.kind === 'water'), ...input.reserves]) obstacleIndex.add({ ...region, bounds: boundsOf(region.polygon) })
  const parcels: Parcel[] = [], buildings: Building[] = [], accessRoads: Road[] = [], openSpaces: Area[] = [], unassignedGround: PolygonRegion[] = [], events: GrowthEvent[] = []
  const history = { parcels: [] as TimelineVersion<Parcel>[], buildings: [] as TimelineVersion<Building>[], buildingStates: [] as BuildingState[] }
  const metrics = { blocks: input.blocks.length, buildableArea: 0, parcelArea: 0, accessArea: 0, openSpaceArea: 0, unassignedArea: 0, partitionAreaError: 0, laneAttempts: 0, accessRoads: 0, privateReplacements: 0, lots: 0, oversizedLots: 0, frontageFailures: 0, formationFailures: 0, openReasons: {} as Record<string, { count: number; area: number }> }
  const obstacles = (region: PolygonRegion) => obstacleIndex.query(boundsOf(region.polygon))
  const frontages = (region: PolygonRegion): Frontage[] => {
    const bounds = boundsOf(region.polygon), near = roadIndex.query({ minX: bounds.minX - 18, minY: bounds.minY - 18, maxX: bounds.maxX + 18, maxY: bounds.maxY + 18 }).filter(segment => publicStreet(segment.road))
    const result: Frontage[] = []
    for (let i = 0; i < region.polygon.length; i++) {
      const a = region.polygon[i]!, b = region.polygon[(i + 1) % region.polygon.length]!, length = distance(a, b)
      if (length < .3) continue
      const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length
      const pieces: { low: number; high: number; segments: Segment[] }[] = []
      for (const segment of near) {
        const size = distance(segment.a, segment.b), alignment = Math.abs(((segment.b.x - segment.a.x) * dx + (segment.b.y - segment.a.y) * dy) / size)
        if (alignment <= .8) continue
        const projected = [segment.a, segment.b].map(p => (p.x - a.x) * dx + (p.y - a.y) * dy), low = Math.max(0, Math.min(...projected)), high = Math.min(length, Math.max(...projected))
        if (high - low < .0001) continue
        const from = { x: a.x + dx * low, y: a.y + dy * low }, to = { x: a.x + dx * high, y: a.y + dy * high }, p = middle(from, to)
        // Clipping merges collinear boundaries across several road samples.
        // Attribute their actual overlapping pieces, not the whole long edge
        // to one short source segment (which would erase shared-lane frontage).
        if (Math.abs(distanceToSegment(p, segment.a, segment.b) - segment.road.width / 2 - .25) < .65 && Math.max(distanceToSegment(from, segment.a, segment.b), distanceToSegment(to, segment.a, segment.b)) <= segment.road.width / 2 + 1) pieces.push({ low, high, segments: [segment] })
      }
      pieces.sort((a, b) => a.segments[0]!.road.id.localeCompare(b.segments[0]!.road.id) || a.low - b.low)
      const merged: typeof pieces = []
      for (const piece of pieces) {
        const previous = merged.at(-1)
        if (previous && previous.segments[0]!.road.id === piece.segments[0]!.road.id && piece.low <= previous.high + .001) { previous.high = Math.max(previous.high, piece.high); previous.segments.push(...piece.segments) }
        else merged.push({ ...piece, segments: [...piece.segments] })
      }
      for (const piece of merged) {
        const from = { x: a.x + dx * piece.low, y: a.y + dy * piece.low }, to = { x: a.x + dx * piece.high, y: a.y + dy * piece.high }, p = middle(from, to)
        const segment = piece.segments.sort((x, y) => distanceToSegment(p, x.a, x.b) - distanceToSegment(p, y.a, y.b))[0]!
        result.push({ a: from, b: to, segment, length: piece.high - piece.low })
      }
    }
    return result.sort((a, b) => b.length - a.length || a.segment.road.id.localeCompare(b.segment.road.id))
  }
  const opening = (p: Point) => Math.max(1650, Math.round(input.demand.openingAt(p)))
  const physical = (polygon: Point[], maximumSlope = .16) => {
    if (polygon.some(p => p.x < 0 || p.y < 0 || p.x > input.width || p.y > input.height) || obstacles({ polygon }).some(region => polygonOverlapsRegion(polygon, region))) return false
    const bounds = boundsOf(polygon), points = samples(polygon)
    for (let x = bounds.minX + 2; x < bounds.maxX; x += 4) for (let y = bounds.minY + 2; y < bounds.maxY; y += 4) if (pointInPolygon({ x, y }, polygon)) points.push({ x, y })
    return points.every(p => !input.terrain.waterAt(p) && Number.isFinite(input.terrain.slope(p)) && input.terrain.slope(p) <= maximumSlope)
  }
  const open = (region: PolygonRegion, id: string, reason: string) => {
    openSpaces.push({ polygon: region.polygon, ...(region.holes?.length ? { holes: region.holes } : {}), id: `cf-o-${id}`, kind: 'park', landUse: 'vacant' })
    const group = metrics.openReasons[reason] ?? { count: 0, area: 0 }; group.count++; group.area += regionArea(region); metrics.openReasons[reason] = group
    metrics.openSpaceArea += regionArea(region)
  }
  const lineEnds = (region: PolygonRegion, p: Point, direction: Point) => {
    const cuts: number[] = []
    for (const ring of [region.polygon, ...region.holes ?? []]) for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!, dx = b.x - a.x, dy = b.y - a.y, determinant = direction.x * dy - direction.y * dx
      if (Math.abs(determinant) < 1e-8) continue
      const x = a.x - p.x, y = a.y - p.y, along = (x * dy - y * dx) / determinant, across = (x * direction.y - y * direction.x) / determinant
      if (across >= 0 && across <= 1) cuts.push(along)
    }
    cuts.sort((a, b) => a - b)
    for (let i = 1; i < cuts.length; i++) if (cuts[i - 1]! < 0 && cuts[i]! > 0) return [cuts[i - 1]!, cuts[i]!] as const
    return null
  }
  const sharedLane = (region: PolygonRegion, block: PolygonRegion, id: string): Road | null => {
    const fronts = frontages(region)
    if (!fronts.length || regionArea(region) < 1800) return null
    const bounds = boundsOf(region.polygon)
    let deepest = interior(region), maximum = 0
    for (let x = bounds.minX + 8; x < bounds.maxX; x += 12) for (let y = bounds.minY + 8; y < bounds.maxY; y += 12) {
      const p = { x, y }; if (!pointInRegion(p, region)) continue
      const depth = Math.min(...fronts.map(front => distanceToSegment(p, front.a, front.b)))
      if (depth > maximum) { maximum = depth; deepest = p }
    }
    if (maximum <= 27) return null
    const longest = fronts[0]!, length = distance(longest.a, longest.b), tangent = { x: (longest.b.x - longest.a.x) / length, y: (longest.b.y - longest.a.y) / length }
    for (const direction of [tangent, { x: -tangent.y, y: tangent.x }]) for (const offset of [0, -10, 10]) {
      const p = { x: deepest.x - direction.y * offset, y: deepest.y + direction.x * offset }
      if (!pointInRegion(p, region)) continue
      const parallel = roadIndex.query({ minX: p.x - 35, minY: p.y - 35, maxX: p.x + 35, maxY: p.y + 35 }).some(segment => {
        const length = distance(segment.a, segment.b), alignment = Math.abs(((segment.b.x - segment.a.x) * direction.x + (segment.b.y - segment.a.y) * direction.y) / length)
        return alignment > .96 && distanceToSegment(p, segment.a, segment.b) < 35
      })
      if (parallel) continue
      const ends = lineEnds(region, p, direction)
      if (!ends) continue
      const tips = ends.map(t => ({ x: p.x + direction.x * t, y: p.y + direction.y * t }))
      const anchors = tips.map(tip => roadIndex.query({ minX: tip.x - 20, minY: tip.y - 20, maxX: tip.x + 20, maxY: tip.y + 20 }).filter(segment => publicStreet(segment.road) && distanceToSegment(tip, segment.a, segment.b) <= segment.road.width / 2 + 1).map(segment => ({ segment, point: projectPoint(tip, segment.a, segment.b) })).sort((a, b) => distance(tip, a.point) - distance(tip, b.point))[0])
      if (!anchors[0] || !anchors[1] || distance(anchors[0].point, anchors[1].point) < 30) continue
      metrics.laneAttempts++
      const points = [anchors[0].point, p, anchors[1].point], width = 4
      const strips = points.slice(1).map((b, i) => ({ polygon: corridorPolygon(points[i]!, b, width / 2 + .25) }))
      if (strips.some(strip => !physical(strip.polygon, .13))) continue
      const publicGround = roadIndex.query(boundsOf(strips.flatMap(strip => strip.polygon))).map(segment => ({ polygon: segment.polygon }))
      if (strips.some(strip => sumArea(subtractRegions(strip, [block, ...publicGround])) > .02)) continue
      const checkpoints = points.slice(1).flatMap((b, i) => {
        const a = points[i]!, count = Math.ceil(distance(a, b) / 4)
        return Array.from({ length: count + 1 }, (_, n) => ({ x: a.x + (b.x - a.x) * n / count, y: a.y + (b.y - a.y) * n / count }))
      })
      if (checkpoints.some((q, i) => i > 0 && Math.abs(input.terrain.elevation(q) - input.terrain.elevation(checkpoints[i - 1]!)) > distance(q, checkpoints[i - 1]!) * .13 + .02)) continue
      const builtYear = Math.max(...checkpoints.filter(q => input.demand.at(q) > 0).map(opening), opening(p), anchors[0].segment.road.builtYear ?? 1650, anchors[1].segment.road.builtYear ?? 1650)
      if (!Number.isFinite(builtYear) || builtYear > 2025) continue
      return { id: `continuous-shared-${id}`, points, width, kind: 'local', role: 'access', builtYear, reason: '閉街区の奥へ接続する実幅の共有接道' }
    }
    return null
  }
  const split = (cell: Cell, seed: string, maximumArea: number): Cell[] | null => {
    const front = cell.frontages[0]!, length = front.length, u = { x: (front.b.x - front.a.x) / length, y: (front.b.y - front.a.y) / length }, v = { x: -u.y, y: u.x }
    const extents = [u, v].map(axis => { const values = cell.polygon.map(p => p.x * axis.x + p.y * axis.y); return { axis, low: Math.min(...values), high: Math.max(...values) } }).sort((a, b) => b.high - b.low - (a.high - a.low))
    const random = seededRandom(seed), count = Math.max(2, Math.round(regionArea(cell) / (maximumArea * .85))), balance = clamp(Math.floor(count / 2) / count + (random() - .5) * .035, .32, .62)
    const b = boundsOf(cell.polygon), reach = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) * 3 + 20
    for (const { axis, low, high } of extents) for (const fraction of [balance, .5, .38, .62]) {
      if (high - low < 11) continue
      const cut = low + (high - low) * fraction, normal = { x: -axis.y, y: axis.x }
      const point = (along: number, across: number): Point => ({ x: axis.x * along + normal.x * across, y: axis.y * along + normal.y * across })
      const across = cell.polygon.map(p => p.x * normal.x + p.y * normal.y), left = Math.min(...across) - reach, right = Math.max(...across) + reach
      const mask = { polygon: [point(low - reach, left), point(cut, left), point(cut, right), point(low - reach, right)] }
      const first = intersectRegions(cell, mask), second = subtractRegions(cell, [mask]), parts = [...first, ...second]
      if (!first.length || !second.length || parts.some(part => regionArea(part) < 48)) continue
      const children = parts.map(part => ({ ...part, frontages: frontages(part) }))
      if (children.some(part => part.frontages.reduce((sum, frontage) => sum + frontage.length, 0) < 3)) continue
      return children
    }
    return null
  }
  const buildingPad = (cell: Cell, front: Frontage, major: boolean) => {
    if (cell.holes?.length) return null
    const origin = middle(front.a, front.b), tangent = { x: (front.b.x - front.a.x) / front.length, y: (front.b.y - front.a.y) / front.length }
    let normal = { x: -tangent.y, y: tangent.x }
    if (!pointInRegion({ x: origin.x + normal.x, y: origin.y + normal.y }, cell)) normal = { x: -normal.x, y: -normal.y }
    const world = (u: number, v: number): Point => ({ x: origin.x + tangent.x * u + normal.x * v, y: origin.y + tangent.y * u + normal.y * v })
    const us = cell.polygon.map(p => (p.x - origin.x) * tangent.x + (p.y - origin.y) * tangent.y), vs = cell.polygon.map(p => (p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y)
    const fullWidth = Math.min(major ? 24 : 12, Math.max(...us) - Math.min(...us) - 1.25), fullDepth = Math.min(major ? 18 : 12, Math.max(...vs) - 3)
    for (const scale of [1, .86, .72, .6]) for (const shift of [0, -1.5, 1.5]) {
      const width = fullWidth * scale, depth = fullDepth * scale, frontGap = major ? 1.3 : 1.6
      if (width < 3.8 || depth < 5 || width * depth < 30) continue
      const polygon = [world(shift - width / 2, frontGap), world(shift + width / 2, frontGap), world(shift + width / 2, frontGap + depth), world(shift - width / 2, frontGap + depth)].map(point => ({ x: Math.round(point.x * 10000) / 10000, y: Math.round(point.y * 10000) / 10000 }))
      if (!containsPolygon(cell, polygon) || !physical(polygon)) continue
      const elevations = [...polygon, middle(polygon[0]!, polygon[2]!)].map(input.terrain.elevation)
      if (Math.max(...elevations) - Math.min(...elevations) > 2.4) continue
      const attachment = projectPoint(origin, front.segment.a, front.segment.b), access = corridorPolygon(attachment, origin, 1.1)
      if (!physical(access) || polygonOverlapsRegion(access, { polygon }) || sumArea(subtractRegions({ polygon: access }, [cell, { polygon: front.segment.polygon }])) > .01) continue
      return { polygon, entrance: origin, attachment }
    }
    return null
  }
  let serial = 0
  for (const block of input.blocks) {
    const cropped = intersectRegions(block, { polygon: rectangle(0, 0, input.width, input.height) })
    const bounds = boundsOf(block.polygon), roads = roadIndex.query(bounds).map(segment => ({ polygon: segment.polygon }))
    let regions = cropped.flatMap(part => subtractRegions(part, [...obstacles(part), ...roads]))
    const initialArea = sumArea(regions); metrics.buildableArea += initialArea
    let blockAccessArea = 0
    for (let laneNumber = 0; laneNumber < 6; laneNumber++) {
      let acquired = false
      for (const region of regions.slice().sort((a, b) => regionArea(b) - regionArea(a))) {
        if (input.demand.at(interior(region)) <= 0) continue
        const lane = sharedLane(region, block, `${block.id}-${laneNumber}`)
        if (!lane) continue
        const strips = lane.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(lane.points[i]!, b, lane.width / 2 + .25) }))
        const next = regions.flatMap(part => subtractRegions(part, strips)), acquiredArea = sumArea(regions) - sumArea(next)
        if (acquiredArea < 1) continue
        accessRoads.push(lane); addRoad(lane); metrics.accessRoads++; blockAccessArea += acquiredArea; regions = next; acquired = true
        if ((lane.builtYear ?? 1650) <= endYear) events.push({ id: `continuous-road-${lane.id}`, year: lane.builtYear ?? 1650, kind: 'road', entityId: lane.id, reason: '閉街区内の共有接道を取得' })
        break
      }
      if (!acquired) break
    }
    metrics.accessArea += blockAccessArea
    const beforeLots = metrics.parcelArea, beforeOpen = metrics.openSpaceArea, beforeUnassigned = metrics.unassignedArea
    const pending: { cell: Cell; depth: number }[] = regions.map(region => ({ cell: { ...region, frontages: frontages(region) }, depth: 0 }))
    let processed = 0
    while (pending.length) {
      const { cell, depth } = pending.pop()!, cellSerial = serial++, id = `${block.id}-${cellSerial}`, p = interior(cell), intensity = clamp(input.demand.at(p), 0, 1), area = regionArea(cell)
      if (!intensity) {
        // Cover owns this ground's woodland/farm classification. Never publish
        // the working Cell (frontages retain complete road/segment objects).
        unassignedGround.push({ polygon: cell.polygon, ...(cell.holes?.length ? { holes: cell.holes } : {}) })
        metrics.unassignedArea += area
        continue
      }
      if (!cell.frontages.length) { metrics.frontageFailures++; open(cell, String(cellSerial), '実接道を確保できない街区内地'); continue }
      const front = cell.frontages[0]!, major = front.segment.road.width >= 8 && intensity >= .58
      const maximumArea = major ? intensity > .8 ? 440 : 360 : intensity >= .72 ? 170 : 280
      if ((area > maximumArea || cell.holes?.length) && depth < 16 && processed++ < 4096) {
        const children = split(cell, `${input.config.seed}:${id}:cut`, maximumArea)
        if (children) { for (const child of children) pending.push({ cell: child, depth: depth + 1 }); continue }
      }
      const pad = buildingPad(cell, front, major)
      const createdYear = Math.max(opening(p), ...(pad?.polygon ?? []).map(opening), front.segment.road.builtYear ?? 1650)
      if (!pad || !Number.isFinite(createdYear) || createdYear > 2025) { metrics.formationFailures++; open(cell, String(cellSerial), pad ? '将来形成する接道地' : '形状・地形上の建築不適地'); continue }
      const parcel: Parcel = { id: `cf-p-${cellSerial}`, polygon: cell.polygon, entrance: pad.entrance, access: [pad.attachment, pad.entrance], roadId: front.segment.road.id, createdYear, developedYear: createdYear, use: major ? 'commercial' : 'residential' }
      metrics.parcelArea += area; metrics.lots++; if (area > maximumArea) metrics.oversizedLots++
      const versions: TimelineVersion<Building>[] = []
      for (let year = createdYear, frame = 0; year <= 2025 && frame < 10; frame++) {
        const random = seededRandom(`${input.config.seed}:${parcel.id}:${year}:frame`), height = year < 1955 ? 1 + Number(random() < .45) : major ? 3 + Math.floor(random() * (intensity > .8 ? 4 : 2)) : intensity >= .75 ? 2 + Math.floor(random() * 3) : 1 + Number(random() < .85)
        const building: Building = { id: `cf-b-${cellSerial}-${year}-${frame}`, polygon: pad.polygon.map(point => ({ ...point })), kind: major ? 'commercial' : 'residential', height, parcelId: parcel.id, builtYear: year, occupancy: 'occupied', occupiedHouseholds: major ? 0 : Math.max(1, Math.floor(polygonArea(pad.polygon) * height / 70)) }
        const next = year + buildingServiceYears(input.config.seed, building)
        versions.push({ from: year, ...(next <= 2025 ? { to: next } : {}), value: building }); year = next
      }
      const visible = versions.filter(version => version.from <= endYear)
      if (createdYear <= endYear && visible.length) {
        parcels.push(parcel); buildings.push({ ...visible.at(-1)!.value })
        history.parcels.push({ from: createdYear, value: parcel })
        history.buildings.push(...visible.map(version => version.to !== undefined && version.to > endYear ? { from: version.from, value: version.value } : version))
        for (const version of visible) {
          events.push({ id: `cf-c-${cellSerial}-${version.from}`, year: version.from, kind: 'construction', entityId: version.value.id, reason: '実街区の接道筆に建築' })
          if (version.to !== undefined && version.to <= endYear) events.push({ id: `cf-d-${cellSerial}-${version.to}`, year: version.to, kind: 'demolition', entityId: version.value.id, reason: '同じ筆の建物を更新' })
        }
        metrics.privateReplacements += visible.length - 1
      }
    }
    metrics.partitionAreaError += Math.abs(initialArea - blockAccessArea - (metrics.parcelArea - beforeLots) - (metrics.openSpaceArea - beforeOpen) - (metrics.unassignedArea - beforeUnassigned))
  }
  events.sort((a, b) => a.year - b.year || a.id.localeCompare(b.id))
  return { parcels, buildings, accessRoads: accessRoads.filter(road => (road.builtYear ?? 1650) <= endYear), openSpaces, unassignedGround, history, events, metrics }
}
