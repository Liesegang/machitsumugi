import type { Point, Road } from './types'
import ClipperLib from 'clipper-lib'
import type { Path, PolyNode } from 'clipper-lib'
import type { PolygonRegion } from './geometry'
import type { AgriculturalTerrain } from './land-use'
import { agriculturalPlotSuitable, agriculturalUse } from './land-use'
import { boundsOf, distance, distanceToSegment, overlaps, pointInRegion, regionArea, seededRandom, subtractRegions } from './geometry'
import { regionQuery } from './region-query'

export interface ContinuousFarmDistrictInput {
  /** The exact pieces of ONE already road-served district, including holes. */
  regions: readonly PolygonRegion[]
  road: Road
  origin: Point
  seed: string
  terrain: AgriculturalTerrain & { waterAt?(point: Point): boolean }
}

const sum = (parts: readonly PolygonRegion[]) => parts.reduce((n, part) => n + regionArea(part), 0)
const onBoundary = (p: Point, region: PolygonRegion) => [region.polygon, ...region.holes ?? []].some(ring => ring.some((a, i) => distanceToSegment(p, a, ring[(i + 1) % ring.length]!) < 1e-6))
function sharedEdge(a: PolygonRegion, b: PolygonRegion) {
  if (!overlaps(boundsOf(a.polygon), boundsOf(b.polygon))) return false
  for (const ring of [a.polygon, ...a.holes ?? []]) for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!, length = distance(p, q)
    if (length < .001) continue
    const ux = (q.x - p.x) / length, uy = (q.y - p.y) / length
    for (const other of [b.polygon, ...b.holes ?? []]) for (let j = 0; j < other.length; j++) {
      const c = other[j]!, d = other[(j + 1) % other.length]!
      if (Math.abs((c.x - p.x) * uy - (c.y - p.y) * ux) > 1e-6 || Math.abs((d.x - p.x) * uy - (d.y - p.y) * ux) > 1e-6) continue
      const ca = (c.x - p.x) * ux + (c.y - p.y) * uy, cb = (d.x - p.x) * ux + (d.y - p.y) * uy
      if (Math.min(length, Math.max(ca, cb)) - Math.max(0, Math.min(ca, cb)) > .05) return true
    }
  }
  return false
}
/** Tractor centre space after a conservative1.25m inset. Public pavement is
 * part of access; cultivated ownership units are not. A narrow neck or a
 * point contact disappears instead of manufacturing a road to the far side. */
function tractorReachablePlots(parts: readonly PolygonRegion[], plots: readonly PolygonRegion[], road: Road, origin: Point) {
  const scale = 1000, anchor = parts[0]!.polygon[0]!, path = (ring: Point[]) => ring.map(p => ({ X: Math.round((p.x - anchor.x) * scale), Y: Math.round((p.y - anchor.y) * scale) }))
  const paths = (regions: readonly PolygonRegion[]) => regions.flatMap(region => [region.polygon, ...region.holes ?? []].map((ring, i) => { const result = path(ring); if (ClipperLib.Clipper.Orientation(result) !== (i === 0)) result.reverse(); return result }))
  const pavement: Path[] = [], roadOffset = new ClipperLib.ClipperOffset(2, .1 * scale)
  roadOffset.AddPath(path(road.points), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etOpenSquare); roadOffset.Execute(pavement, road.width / 2 * scale)
  const free: Path[] = [], boolean = new ClipperLib.Clipper()
  boolean.AddPaths([...paths(parts), ...pavement], ClipperLib.PolyType.ptSubject, true)
  if (plots.length) boolean.AddPaths(paths(plots), ClipperLib.PolyType.ptClip, true)
  if (!boolean.Execute(ClipperLib.ClipType.ctDifference, free, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) return { reached: new Set<number>(), blocking: [] as number[] }
  const inset = new ClipperLib.ClipperOffset(2, .1 * scale), tree = new ClipperLib.PolyTree()
  inset.AddPaths(free, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon); inset.Execute(tree, -1.25 * scale)
  const working: PolygonRegion[] = [], isolated: PolygonRegion[] = [], ring = (node: PolyNode) => node.Contour().map(p => ({ x: p.X / scale + anchor.x, y: p.Y / scale + anchor.y }))
  const visit = (node: PolyNode) => { if (!node.IsHole() && node.Contour().length >= 3) { const region = { polygon: ring(node), holes: node.Childs().filter(child => child.IsHole()).map(ring) }; (pointInRegion(origin, region) || onBoundary(origin, region) ? working : isolated).push(region) } for (const child of node.Childs()) visit(child) }
  visit(tree)
  const boundaryEdges = (components: PolygonRegion[]) => components.flatMap(component => [component.polygon, ...component.holes ?? []].flatMap(boundary => boundary.map((c, i) => {
    const d = boundary[(i + 1) % boundary.length]!
    return { c, d, dx: d.x - c.x, dy: d.y - c.y, run: distance(c, d) }
  }))).filter(edge => !(edge.run < .05))
  const workingEdges = boundaryEdges(working), isolatedEdges = boundaryEdges(isolated)
  const adjacent = (plot: PolygonRegion, edges: ReturnType<typeof boundaryEdges>) => {
  for (let edge = 0; edge < plot.polygon.length; edge++) {
    const a = plot.polygon[edge]!, b = plot.polygon[(edge + 1) % plot.polygon.length]!, length = distance(a, b), ux = (b.x - a.x) / length, uy = (b.y - a.y) / length
    for (const { c, d, dx, dy, run } of edges) {
      if (Math.abs((dx * ux + dy * uy) / run) < .999) continue
      const ca = (c.x - a.x) * ux + (c.y - a.y) * uy, cb = (d.x - a.x) * ux + (d.y - a.y) * uy
      // This is centre space AFTER the1.25m inset. Its positive gate already
      // carries a2.5m vehicle envelope; requiring another2.4m here would
      // incorrectly demand a4.9m-wide physical lane.
      if (Math.abs((c.x - a.x) * -uy + (c.y - a.y) * ux) <= 1.3 && Math.min(length, Math.max(ca, cb)) - Math.max(0, Math.min(ca, cb)) >= .05) return true
    }
  }
  return false
  }
  const reached = new Set<number>(), blocking: number[] = []
  for (const [index, plot] of plots.entries()) if (adjacent(plot, workingEdges)) { reached.add(index); if (adjacent(plot, isolatedEdges)) blocking.push(index) }
  return { reached, blocking }
}

/** Field ownership follows one actual access/contour survey. The remainder is
 * real grassed bunds and field access, not another painted farm rectangle.
 * Natural banks reject whole units; water/woodland boundaries never trim them
 * into curved slivers. Positive-width seams retain access across storage tiles. */
export function subdivideContinuousFarmDistrict(input: ContinuousFarmDistrictInput) {
  const { road, origin, terrain } = input, untouched = () => ({ plots: [] as (PolygonRegion & { landUse: 'paddy' | 'dry-field' })[], bunds: [...input.regions], diagnostics: { plots: 0, servedParts: 0, areaError: 0, bearing: 0, workingLaneWidth: 2.5, accessRejectedPlots: 0 } })
  if (!input.regions.length || road.controlledAccess || road.role === 'expressway' || road.role === 'ramp' || (road.level ?? 0) !== 0 || road.points.length < 2) return untouched()
  const segments = road.points.slice(1).map((b, i) => ({ a: road.points[i]!, b }))
  if (!segments.some(s => distanceToSegment(origin, s.a, s.b) <= road.width / 2 + .05)) return untouched()
  const served = new Set<number>(), pending: number[] = []
  for (const [i, region] of input.regions.entries()) if ([region.polygon, ...region.holes ?? []].some(ring => ring.some(p => segments.some(s => distanceToSegment(p, s.a, s.b) <= road.width / 2 + .05)))) { served.add(i); pending.push(i) }
  for (let i = 0; i < pending.length; i++) for (let j = 0; j < input.regions.length; j++) if (!served.has(j) && sharedEdge(input.regions[pending[i]!]!, input.regions[j]!)) { served.add(j); pending.push(j) }
  const parts = input.regions.filter((_, i) => served.has(i))
  if (!parts.length) return untouched()
  const segment = [...segments].sort((a, b) => distanceToSegment(origin, a.a, a.b) - distanceToSegment(origin, b.a, b.b))[0]!
  let bearing = Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x)
  const center = boundsOf(parts.flatMap(p => p.polygon)), probe = { x: (center.minX + center.maxX) / 2, y: (center.minY + center.maxY) / 2 }
  const gx = (terrain.elevation({ x: probe.x + 30, y: probe.y }) - terrain.elevation({ x: probe.x - 30, y: probe.y })) / 60
  const gy = (terrain.elevation({ x: probe.x, y: probe.y + 30 }) - terrain.elevation({ x: probe.x, y: probe.y - 30 })) / 60
  const contour = Math.atan2(gy, gx) + Math.PI / 2
  if (Math.hypot(gx, gy) > .006 && Math.abs(Math.sin(2 * (bearing - contour))) > Math.sin(Math.PI / 8)) bearing = contour
  const c = Math.cos(bearing), s = Math.sin(bearing), local = (p: Point) => ({ x: (p.x - origin.x) * c + (p.y - origin.y) * s, y: -(p.x - origin.x) * s + (p.y - origin.y) * c })
  // New surveyed units use the same0.1mm cadastral lattice as their later
  // differences. Existing district/water vertices are never rewritten.
  const world = (x: number, y: number) => ({ x: Math.round((origin.x + x * c - y * s) * 10000) / 10000, y: Math.round((origin.y + x * s + y * c) * 10000) / 10000 })
  const bounds = boundsOf(parts.flatMap(p => p.polygon.map(local))), random = seededRandom(`${input.seed}:actual-farm:${road.id}:${origin.x.toFixed(3)}:${origin.y.toFixed(3)}`)
  const containsGround = regionQuery(parts), boundaryBands = new Map<number, { a: Point; b: Point; minX: number; maxX: number; minY: number; maxY: number }[]>(), boundaryPadding = 1e-6 + 1e-9
  // The index only removes edges farther than the original1e-6m predicate.
  // Keep source order and ALL holes, including a hole outside its outer ring;
  // containment bounds must never erase a separately valid boundary hit.
  for (const region of parts) for (const ring of [region.polygon, ...region.holes ?? []]) for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, edge = { a, b, minX: Math.min(a.x, b.x) - boundaryPadding, maxX: Math.max(a.x, b.x) + boundaryPadding, minY: Math.min(a.y, b.y) - boundaryPadding, maxY: Math.max(a.y, b.y) + boundaryPadding }
    for (let band = Math.floor(edge.minY / 20); band <= Math.floor(edge.maxY / 20); band++) { const edges = boundaryBands.get(band) ?? []; edges.push(edge); boundaryBands.set(band, edges) }
  }
  const onGroundBoundary = (point: Point) => (boundaryBands.get(Math.floor(point.y / 20)) ?? []).some(edge => point.x >= edge.minX && point.x <= edge.maxX && point.y >= edge.minY && point.y <= edge.maxY && distanceToSegment(point, edge.a, edge.b) < 1e-6)
  const suitable = (point: Point) => (containsGround(point) || onGroundBoundary(point)) && !terrain.waterAt?.(point) && terrain.slope(point) <= .12 && (terrain.cultivable?.(point) ?? true)
  const divisions = (low: number, high: number, target: number, rng: () => number) => {
    const count = Math.max(1, Math.ceil((high - low) / target)), weights = Array.from({ length: count }, () => .65 + rng() * .7), total = weights.reduce((a, b) => a + b, 0), values = [low]
    for (const weight of weights) values.push(values.at(-1)! + (high - low) * weight / total)
    return values
  }
  type SurveyCell = { x0: number; x1: number; y0: number; y1: number; key: string }
  const rows = divisions(bounds.minY, bounds.maxY, 44 + random() * 12, random), plots: (PolygonRegion & { landUse: 'paddy' | 'dry-field' })[] = [], rejected: SurveyCell[] = []
  for (let row = 1; row < rows.length && plots.length < 2048; row++) {
    const columns = divisions(bounds.minX, bounds.maxX, 58 + random() * 24, seededRandom(`${input.seed}:${road.id}:field-band-${row}`))
    for (let col = 1; col < columns.length && plots.length < 2048; col++) {
      //2.6m of grassed working access separates the primary holdings.
      const x0 = columns[col - 1]! + 1.3, x1 = columns[col]! - 1.3, y0 = rows[row - 1]! + 1.3, y1 = rows[row]! - 1.3
      if (x1 - x0 < 12 || y1 - y0 < 12 || (x1 - x0) * (y1 - y0) < 200) continue
      const polygon = [world(x0, y0), world(x1, y0), world(x1, y1), world(x0, y1)]
      if (!agriculturalPlotSuitable(polygon, suitable) || sum(subtractRegions({ polygon }, parts)) > .001) { rejected.push({ x0: columns[col - 1]!, x1: columns[col]!, y0: rows[row - 1]!, y1: rows[row]!, key: `${row}:${col}` }); continue }
      plots.push({ polygon, landUse: agriculturalUse(polygon, terrain) })
    }
  }
  const remainingGround = () => {
    const indexed = plots.map(plot => ({ plot, bounds: boundsOf(plot.polygon) }))
    return parts.flatMap(region => { const bounds = boundsOf(region.polygon); return subtractRegions(region, indexed.filter(item => overlaps(bounds, item.bounds)).map(item => item.plot)) })
  }
  // A whole primary holding can fail at an irregular shore or hollow without
  // making its entire50×70m survey cell unusable. Refine only those rejected
  // cells, keeping the original access/contour bearing and coherent bands.
  // No successful title moves and no curved boundary clips a field rectangle.
  // Refine each failed physical holding before sliding a lattice across the
  // district's bounding box. One wet/steep corner must not abandon the dry
  // centre of a50×70m cell. Round-robin quadrants give every rejected holding
  // a first survey before any one of them consumes the remaining budget.
  let refinementAttempts = 0
  const refinementLimit = Math.min(8192, rejected.length * 38), refined = new Map<SurveyCell, SurveyCell[]>()
  for (const divisions of [2, 3]) for (let index = 0; index < divisions * divisions && plots.length < 2048 && refinementAttempts < refinementLimit; index++) for (const cell of rejected) {
    if (plots.length >= 2048 || refinementAttempts >= refinementLimit) break
    const column = index % divisions, row = Math.floor(index / divisions), dx = (cell.x1 - cell.x0) / divisions, dy = (cell.y1 - cell.y0) / divisions
    const candidate = { x0: cell.x0 + column * dx, x1: cell.x0 + (column + 1) * dx, y0: cell.y0 + row * dy, y1: cell.y0 + (row + 1) * dy, key: cell.key }
    if (dx - 2.6 < 12 || dy - 2.6 < 12 || (dx - 2.6) * (dy - 2.6) < 200 || refined.get(cell)?.some(other => candidate.x0 < other.x1 - .0001 && candidate.x1 > other.x0 + .0001 && candidate.y0 < other.y1 - .0001 && candidate.y1 > other.y0 + .0001)) continue
    refinementAttempts++
    const expanded = { polygon: [world(candidate.x0, candidate.y0), world(candidate.x1, candidate.y0), world(candidate.x1, candidate.y1), world(candidate.x0, candidate.y1)] }
    if (!suitable(world((candidate.x0 + candidate.x1) / 2, (candidate.y0 + candidate.y1) / 2)) || !agriculturalPlotSuitable(expanded.polygon, suitable) || sum(subtractRegions(expanded, parts)) > .001) continue
    const polygon = [world(candidate.x0 + 1.3, candidate.y0 + 1.3), world(candidate.x1 - 1.3, candidate.y0 + 1.3), world(candidate.x1 - 1.3, candidate.y1 - 1.3), world(candidate.x0 + 1.3, candidate.y1 - 1.3)]
    plots.push({ polygon, landUse: agriculturalUse(polygon, terrain) }); const accepted = refined.get(cell) ?? []; accepted.push(candidate); refined.set(cell, accepted)
  }
  // An unlucky primary corner also belongs to each anchored quadrant/third.
  // Slide a minimum viable WHOLE title within that same failed holding,
  // interleaving the25 finite positions across all holdings. No distant
  // district lattice has to happen to find its narrow cultivable centre.
  const offsets = [0, .5, 1, .25, .75]
  for (let index = 0; index < 25 && plots.length < 2048 && refinementAttempts < refinementLimit; index++) for (const cell of rejected) {
    if (plots.length >= 2048 || refinementAttempts >= refinementLimit) break
    const width = 15.2, depth = 19, dx = cell.x1 - cell.x0 - width, dy = cell.y1 - cell.y0 - depth
    if (dx < 0 || dy < 0) continue
    const x0 = cell.x0 + offsets[index % 5]! * dx, y0 = cell.y0 + offsets[Math.floor(index / 5)]! * dy, candidate = { x0, x1: x0 + width, y0, y1: y0 + depth, key: cell.key }
    if (refined.get(cell)?.some(other => candidate.x0 < other.x1 - .0001 && candidate.x1 > other.x0 + .0001 && candidate.y0 < other.y1 - .0001 && candidate.y1 > other.y0 + .0001) || !suitable(world(x0 + width / 2, y0 + depth / 2))) continue
    refinementAttempts++
    const expanded = { polygon: [world(x0, y0), world(candidate.x1, y0), world(candidate.x1, candidate.y1), world(x0, candidate.y1)] }
    if (!agriculturalPlotSuitable(expanded.polygon, suitable) || sum(subtractRegions(expanded, parts)) > .001) continue
    const polygon = [world(x0 + 1.3, y0 + 1.3), world(candidate.x1 - 1.3, y0 + 1.3), world(candidate.x1 - 1.3, candidate.y1 - 1.3), world(x0 + 1.3, candidate.y1 - 1.3)]
    plots.push({ polygon, landUse: agriculturalUse(polygon, terrain) }); const accepted = refined.get(cell) ?? []; accepted.push(candidate); refined.set(cell, accepted)
  }
  let remaining = remainingGround(), attempts = 0
  const bands = (low: number, high: number, pitch: number, phase: number) => {
    const first = Math.floor((low - phase) / pitch) * pitch + phase, count = Math.max(1, Math.ceil((high - first) / pitch) + 1), queue: [number, number][] = [[0, count - 1]], values: number[] = []
    // Breadth-first midpoint order surveys the whole actual component before
    // refining neighbouring bands. A north/west scan must not consume every
    // attempt before reaching an otherwise cultivable southern holding.
    for (let index = 0; index < queue.length; index++) { const [left, right] = queue[index]!, middle = Math.floor((left + right) / 2); values.push(first + middle * pitch); if (left < middle) queue.push([left, middle - 1]); if (middle < right) queue.push([middle + 1, right]) }
    return values
  }
  for (let pass = 0; pass < 3 && rejected.length && plots.length < 2048 && attempts < 2048; pass++) {
    const allowance = [512, 768, 768][pass]!, passLimit = Math.min(2048, attempts + allowance)
    const rng = seededRandom(`${input.seed}:${road.id}:remaining-field-bands-${pass}`), inset = 2.5, depth = pass === 0 ? 22 + rng() * 13 : pass === 1 ? 16 + rng() * 9 : 16 + rng() * 5, pitchY = (depth + inset * 2) / 4, phaseY = rng() * pitchY
    const added: { x0: number; x1: number; y0: number; y1: number }[] = []
    // The quarter-pitch search slides coherent whole holdings into actual free
    // components. It does not reuse the rejected coarse cell's unlucky cuts,
    // nor draw their bounding box or search probes as field boundaries.
    const components = remaining.filter(component => regionArea(component) >= 260).sort((a, b) => regionArea(b) - regionArea(a)), totalWeight = components.reduce((sum, component) => sum + Math.sqrt(regionArea(component)), 0)
    for (const component of components) {
      const bounds = boundsOf(component.polygon.map(local))
      const componentLimit = Math.min(passLimit, attempts + Math.max(1, Math.floor(allowance * Math.sqrt(regionArea(component)) / totalWeight)))
      const rows = bands(bounds.minY, bounds.maxY + pitchY - depth, pitchY, phaseY), rowSurveys = new Map<number, { y: number; width: number; xs: number[] }>()
      const surveyRow = (rank: number) => {
        if (rank >= rows.length) return undefined
        let survey = rowSurveys.get(rank)
        if (!survey) { const y = rows[rank]!, row = Math.round((y - phaseY) / pitchY), band = seededRandom(`${input.seed}:${road.id}:remaining-field-band-${pass}:${row}`), width = pass === 0 ? 32 + band() * 13 : pass === 1 ? 18 + band() * 12 : 12 + band() * 6, pitchX = (width + inset * 2) / 4; survey = { y, width, xs: bands(bounds.minX, bounds.maxX + pitchX - width, pitchX, band() * pitchX) }; rowSurveys.set(rank, survey) }
        return survey
      }
      const cells = function* () {
        const maximumRank = Math.max(rows.length, Math.ceil((bounds.maxX - bounds.minX) / (pass === 0 ? 9.25 : pass === 1 ? 5.75 : 4.25)) + 8)
        for (let rank = 0; rank < maximumRank; rank++) {
          const row = surveyRow(rank)
          if (row) for (let col = 0; col < Math.min(rank, row.xs.length); col++) yield { x: row.xs[col]!, y: row.y, width: row.width }
          for (let r = 0; r <= Math.min(rank, rows.length - 1); r++) { const row = surveyRow(r)!; if (rank < row.xs.length) yield { x: row.xs[rank]!, y: row.y, width: row.width } }
        }
      }
      // Interleave BOTH survey axes. Completing every column of one band
      // before the next would still starve most of a kilometre-wide district.
      for (const { x, y, width } of cells()) {
          if (plots.length >= 2048 || attempts >= componentLimit) break
          const cell = { x0: x, x1: x + width + inset * 2, y0: y, y1: y + depth + inset * 2 }
          if (added.some(plot => cell.x0 < plot.x1 && cell.x1 > plot.x0 && cell.y0 < plot.y1 && cell.y1 > plot.y0)) continue
          const expanded = { polygon: [world(cell.x0, cell.y0), world(cell.x1, cell.y0), world(cell.x1, cell.y1), world(cell.x0, cell.y1)] }
          if (!expanded.polygon.every(p => pointInRegion(p, component) || onBoundary(p, component))) continue
          attempts++
          if (!suitable(world(x + width / 2 + inset, y + depth / 2 + inset))) continue
          if (!agriculturalPlotSuitable(expanded.polygon, suitable) || sum(subtractRegions(expanded, [component])) > .001) continue
          const polygon = [world(cell.x0 + inset, cell.y0 + inset), world(cell.x1 - inset, cell.y0 + inset), world(cell.x1 - inset, cell.y1 - inset), world(cell.x0 + inset, cell.y1 - inset)]
          if (regionArea({ polygon }) < 200) continue
          plots.push({ polygon, landUse: agriculturalUse(polygon, terrain) }); added.push({ x0: cell.x0 + inset, x1: cell.x1 - inset, y0: cell.y0 + inset, y1: cell.y1 - inset })
      }
    }
    remaining = remainingGround()
  }
  const proposedPlots = plots.length
  let working = tractorReachablePlots(parts, plots, road, origin)
  // A proposed field at a narrow entrance must yield working ground to the
  // holdings behind it. Open a bounded number of such surveyed bottlenecks,
  // rather than retaining the blocker and abandoning an entire dry backland.
  for (let repair = 0; working.reached.size < plots.length && working.blocking.length && repair < 8; repair++) {
    const index = working.blocking.sort((a, b) => regionArea(plots[a]!) - regionArea(plots[b]!))[0]!
    plots.splice(index, 1); working = tractorReachablePlots(parts, plots, road, origin)
  }
  for (let i = plots.length - 1; i >= 0; i--) if (!working.reached.has(i)) plots.splice(i, 1)
  const indexed = plots.map(plot => ({ plot, bounds: boundsOf(plot.polygon) }))
  const bunds = input.regions.flatMap(region => { const bounds = boundsOf(region.polygon); return subtractRegions(region, indexed.filter(item => overlaps(bounds, item.bounds)).map(item => item.plot)) })
  return { plots, bunds, diagnostics: { plots: plots.length, servedParts: parts.length, areaError: sum(input.regions) - sum(plots) - sum(bunds), bearing, workingLaneWidth: 2.5, accessRejectedPlots: proposedPlots - plots.length } }
}
