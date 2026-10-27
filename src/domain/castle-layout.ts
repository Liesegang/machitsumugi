import ClipperLib from 'clipper-lib'
import { corridorPolygon, intersectRegions, pointInPolygon, polygonArea, polygonOverlapsRegion, rectangle, seededRandom, subtractRegions } from './geometry'
import type { PlanningTerrain } from './road-planner'
import type { Area, Building, Point, Road } from './types'

interface CastleSurveyInput {
  width: number
  height: number
  terrain: Pick<PlanningTerrain, 'elevation' | 'slope' | 'waterAt'>
  riverTangent?: Point
  waterAreas?: readonly Area[]
}
interface EnclosureDesign { angle: number; scaleX: number; scaleY: number }

/** This union is the actual reserved ground of the compounds, banks and gate
 * causeways. A convex hull would restore the old detached polygonal park. */
function unionLand(polygons: Point[][]) {
  const precision = 1_000_000
  const clipper = new ClipperLib.Clipper(), paths = polygons.map(polygon => {
    const path = polygon.map(p => ({ X: Math.round(p.x * precision), Y: Math.round(p.y * precision) }))
    if (!ClipperLib.Clipper.Orientation(path)) path.reverse()
    return path
  })
  clipper.StrictlySimple = true
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const result = new ClipperLib.PolyTree()
  if (!clipper.Execute(ClipperLib.ClipType.ctUnion, result, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) throw new Error('城郭用地の結合に失敗しました。')
  const regions: { polygon: Point[]; holes?: Point[][] }[] = []
  const ring = (path: ClipperLib.Path) => path.map(p => ({ x: p.X / precision, y: p.Y / precision }))
  const visit = (node: ClipperLib.PolyNode) => {
    if (!node.IsHole() && node.Contour().length >= 3) {
      const holes = node.Childs().filter(child => child.IsHole()).map(child => ring(child.Contour()))
      regions.push({ polygon: ring(node.Contour()), ...(holes.length ? { holes } : {}) })
    }
    for (const child of node.Childs()) visit(child)
  }
  visit(result)
  return regions
}
function reservedOutline(polygons: Point[][]) { return unionLand(polygons).sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0]!.polygon }

/** Three independently dimensioned compounds, separated by walls/ditches and
 * joined at offset gates. Water occupies explicit wall-side reaches; no closed
 * constant-distance moat is extruded around a polygonal central icon. */
export function castleLayout(origin: Point, seed: string, riverTangent?: Point, design?: EnclosureDesign) {
  const random = seededRandom(`${seed}:castle-enclosures`)
  const between = (a: number, b: number) => a + (b - a) * random()
  const angle = design?.angle ?? (riverTangent ? Math.atan2(riverTangent.y, riverTangent.x) - Math.PI / 2 : 0) + between(-.09, .09)
  const sx = design?.scaleX ?? between(.90, 1.02), sy = design?.scaleY ?? between(.90, 1.02), shear = design ? 0 : between(-.06, .06)
  const c = Math.cos(angle), sine = Math.sin(angle)
  const transform = (p: Point): Point => {
    const x = p.x * sx + p.y * shear, y = p.y * sy
    return { x: origin.x + x * c - y * sine, y: origin.y + x * sine + y * c }
  }
  const shape = (pairs: number[][]) => pairs.map(([x, y]) => ({ x: x!, y: y! }))
  // Dimensions, offsets and defensive doglegs vary independently. The narrow
  // gate necks and unequal courts are functional geometry, not radial jitter.
  const h = { left: between(-211, -199), right: between(-38, -26), top: between(-193, -177), bottom: between(-16, -8) }
  const n = { left: between(2, 18), right: between(182, 204), top: between(-136, -124), bottom: between(70, 80) }
  const s = { left: between(-168, -152), right: between(167, 187), top: between(104, 116), bottom: between(199, 211) }
  const hNotch = between(26, 36), nNotch = between(29, 39), sNotch = between(37, 52)
  const honmaru = shape([[h.left,h.top+30],[h.left+30,h.top+30],[h.left+30,h.top],[h.right-45,h.top],[h.right-45,h.top+18],[h.right,h.top+18],[h.right,h.bottom-hNotch],[h.right-22,h.bottom-hNotch],[h.right-22,h.bottom],[h.left+20,h.bottom],[h.left+20,h.bottom-22],[h.left,h.bottom-22]])
  const ninomaru = shape([[n.left,n.top],[n.right-35,n.top],[n.right-35,n.top+24],[n.right,n.top+24],[n.right,n.bottom-35],[n.right-25,n.bottom-35],[n.right-25,n.bottom],[n.left+nNotch,n.bottom],[n.left+nNotch,n.bottom-28],[n.left,n.bottom-28]])
  const sannomaru = shape([[s.left,s.top+22],[s.left+sNotch,s.top+22],[s.left+sNotch,s.top],[s.right-50,s.top],[s.right-50,s.top+18],[s.right,s.top+18],[s.right,s.bottom-25],[s.right-25,s.bottom-25],[s.right-25,s.bottom],[s.left+25,s.bottom],[s.left+25,s.bottom-20],[s.left,s.bottom-20]])
  const hGateY = h.bottom - 55, northSouthGateX = n.left + 62, outerGateX = northSouthGateX + between(24, 30), outerGateY = s.bottom
  const innerGate = corridorPolygon({ x: h.right - 16, y: hGateY }, { x: n.left + 18, y: hGateY }, 8)
  const middleGate = corridorPolygon({ x: northSouthGateX, y: n.bottom - 18 }, { x: northSouthGateX, y: s.top + 18 }, 8)
  const outerGate = corridorPolygon({ x: outerGateX, y: outerGateY - 18 }, { x: outerGateX, y: outerGateY + 38 }, 9)
  const bentGate = corridorPolygon({ x: northSouthGateX - 5, y: outerGateY - 28 }, { x: outerGateX + 3, y: outerGateY - 28 }, 6)
  const guardGate = corridorPolygon({ x: outerGateX, y: outerGateY - 12 }, { x: outerGateX + 26, y: outerGateY - 12 }, 4)
  const cuts = [innerGate, middleGate, outerGate, bentGate, guardGate].map(polygon => ({ polygon }))
  const westWidth = between(17, 23), northWidth = between(18, 27), eastWidth = between(17, 24), lowerWidth = between(15, 22)
  const hDitch = shape([[h.left-8-westWidth,h.bottom-8],[h.left-8-westWidth,h.top+8],[h.left-12,h.top+8],[h.left-12,h.top-6-northWidth],[h.right-32,h.top-6-northWidth],[h.right-32,h.top-10],[h.right+8+eastWidth,h.top-10],[h.right+8+eastWidth,h.bottom-34],[h.right+8,h.bottom-34],[h.right+8,h.top+6],[h.right-37,h.top+6],[h.right-37,h.top-6],[h.left+4,h.top-6],[h.left+4,h.top+24],[h.left-8,h.top+24],[h.left-8,h.bottom-8]])
  const outerDitch = shape([[n.right+10,n.top+48],[n.right+32,n.top+48],[n.right+32,n.bottom+12],[s.right+32,s.top-5],[s.right+32,s.bottom+8+lowerWidth],[s.right-15,s.bottom+8+lowerWidth],[s.right-15,s.bottom+19],[s.left+42,s.bottom+19],[s.left+42,s.bottom+8],[s.right+10,s.bottom+8],[s.right+10,s.top+18],[n.right+10,n.bottom+28]])
  const moat = subtractRegions({ polygon: hDitch }, cuts)
  const ditches = subtractRegions({ polygon: outerDitch }, cuts)
  const areas: Area[] = [
    ...moat.map((region, i): Area => ({ id: `moat-inner-${i}`, kind: 'water', polygon: region.polygon.map(transform), ...(region.holes ? { holes: region.holes.map(ring => ring.map(transform)) } : {}) })),
    ...ditches.map((region, i): Area => ({ id: `moat-outer-remnant-${i}`, kind: 'water', polygon: region.polygon.map(transform), ...(region.holes ? { holes: region.holes.map(ring => ring.map(transform)) } : {}) })),
  ]
  const building = (id: string, x: number, y: number, w: number, h: number, height: number): Building => ({ id, polygon: rectangle(x, y, w, h).map(transform), kind: 'public', height, builtYear: 1650 })
  const keep = { x: h.left + 42, y: h.top + 42 }, small = { x: h.left + 91, y: h.top + 46 }
  const palace = { x: h.left + 42, y: h.bottom - 76 }, secondPalace = { x: n.left + 88, y: n.top + 57 }
  const keepX = keep.x + 15, smallX = small.x + 9, keepWalkY = h.top + 79, palaceDoor = { x: palace.x + 81, y: hGateY }, secondPalaceY = secondPalace.y + 19
  const structures = [
    building('castle-keep', keep.x, keep.y, 30, 25, 5),
    building('castle-small-keep', small.x, small.y, 18, 16, 3),
    building('castle-palace', palace.x, palace.y, 78, 38, 1),
    building('castle-ninomaru-palace', secondPalace.x, secondPalace.y, 66, 38, 1),
    building('castle-sannomaru-storehouse', s.left + 60, s.top + 27, 50, 22, 1),
    building('castle-ote-guardhouse', outerGateX + 18, outerGateY - 32, 8, 10, 1),
  ].filter(b => !areas.some(area => polygonOverlapsRegion(b.polygon, area)))
  const wall = (name: string, polygon: Point[], extra: Point[][] = []) => {
    const strips = [...polygon.map((a, i) => corridorPolygon(a, polygon[(i + 1) % polygon.length]!, 3.5)), ...extra]
    // Union strips before clipping so adjacent stone-wall faces do not create
    // coplanar duplicate meshes at their corners in the 3D map.
    return unionLand(strips).flatMap(region => intersectRegions(region, { polygon })).flatMap(region => subtractRegions(region, cuts))
      .map((region, i): Area => ({ id: `castle-wall-${name}-${i}`, kind: 'field', landUse: 'vacant', polygon: region.polygon.map(transform), ...(region.holes ? { holes: region.holes.map(ring => ring.map(transform)) } : {}) }))
  }
  const courtWalls = [
    corridorPolygon({ x: outerGateX - 14, y: outerGateY - 36 }, { x: outerGateX + 14, y: outerGateY - 36 }, 1.75),
    corridorPolygon({ x: outerGateX - 14, y: outerGateY - 36 }, { x: outerGateX - 14, y: outerGateY }, 1.75),
    corridorPolygon({ x: outerGateX + 14, y: outerGateY - 36 }, { x: outerGateX + 14, y: outerGateY }, 1.75),
  ]
  // The spaces between the three baileys belong to the defended precinct as
  // well. Reserving only their walls and narrow gate bridges left these courts
  // available to the residential subdivision, creating houses inside the castle.
  // Follow the inherited bailey offsets; the outer western and northern
  // re-entrants remain outside rather than filling a hull or a bounding box.
  const connectingCourt = shape([[h.left+20,h.bottom-28],[h.right-22,h.bottom-28],
    [n.left+36,n.top+30],[n.left+36,n.bottom-28],[n.right-25,n.bottom-28],
    [s.right-50,s.top+18],[s.right-50,s.bottom-25],[s.left+25,s.bottom-25],
    [s.left+25,s.top+22],[h.left+20,s.top+22]])
  const connectingGrounds = subtractRegions({ polygon: connectingCourt }, [...moat, ...ditches, ...[honmaru, ninomaru, sannomaru].map(polygon => ({ polygon }))])
  const grounds: Area[] = [
    ...connectingGrounds.map((region, i): Area => ({ id: `castle-courtyard-connecting-${i}`, kind: 'field', landUse: 'vacant', polygon: region.polygon.map(transform), ...(region.holes ? { holes: region.holes.map(ring => ring.map(transform)) } : {}) })),
    { id: 'castle-courtyard-honmaru', kind: 'field', landUse: 'vacant', polygon: honmaru.map(transform) },
    { id: 'castle-courtyard-ninomaru', kind: 'field', landUse: 'vacant', polygon: ninomaru.map(transform) },
    { id: 'castle-courtyard-sannomaru', kind: 'field', landUse: 'vacant', polygon: sannomaru.map(transform) },
    ...wall('honmaru', honmaru), ...wall('ninomaru', ninomaru), ...wall('sannomaru', sannomaru, courtWalls),
  ]
  const route = (id: string, pairs: number[][], width: number): Road => ({ id, points: shape(pairs).map(transform), width, kind: 'local', role: 'access', builtYear: 1650, reason: '城郭の門・曲輪・御殿を結ぶ城内通路' })
  // Each branch shares an exact vertex with the gate-to-palace route. These
  // paths cross water only where the moat geometry has an actual dry gate.
  const paths = [
    route('castle-path-main', [[outerGateX,outerGateY-12],[outerGateX,outerGateY-28],[northSouthGateX,outerGateY-28],[northSouthGateX,s.top+38],[northSouthGateX,n.bottom-14],[northSouthGateX,secondPalaceY],[northSouthGateX,hGateY],[n.left+14,hGateY],[h.right-13,hGateY],[palaceDoor.x,palaceDoor.y]], 4),
    route('castle-path-ninomaru', [[northSouthGateX,secondPalaceY],[secondPalace.x-3,secondPalaceY]], 3.5),
    route('castle-path-keep', [[palaceDoor.x,palaceDoor.y],[palaceDoor.x,keepWalkY],[smallX,keepWalkY],[keepX,keepWalkY],[keepX,keep.y+28]], 3.5),
    route('castle-path-small-keep', [[smallX,keepWalkY],[smallX,small.y+19]], 3.5),
    route('castle-path-sannomaru', [[northSouthGateX,s.top+38],[s.left+113,s.top+38]], 3.5),
    route('castle-path-guardhouse', [[outerGateX,outerGateY-12],[outerGateX+14,outerGateY-12],[outerGateX+22,outerGateY-12],[outerGateX+22,outerGateY-19]], 2.8),
  ]
  const ditchBanks = [hDitch, outerDitch].flatMap(polygon => polygon.map((a, i) => corridorPolygon(a, polygon[(i + 1) % polygon.length]!, 10)))
  const coreLocal = reservedOutline([honmaru, ninomaru, sannomaru, connectingCourt, hDitch, outerDitch, ...ditchBanks,
    corridorPolygon({ x: h.right - 16, y: hGateY }, { x: n.left + 18, y: hGateY }, 12),
    corridorPolygon({ x: northSouthGateX, y: n.bottom - 16 }, { x: northSouthGateX, y: s.top + 16 }, 13),
    corridorPolygon({ x: outerGateX, y: outerGateY - 12 }, { x: outerGateX, y: outerGateY + 24 }, 10),
  ])
  return {
    core: coreLocal.map(transform), areas, structures, grounds, paths,
    gate: { inside: transform({ x: outerGateX, y: outerGateY - 12 }), outside: transform({ x: outerGateX, y: outerGateY + 52 }) },
    point: transform({ x: keep.x + 15, y: keep.y + 12.5 }),
    enclosures: { honmaru: honmaru.map(transform), ninomaru: ninomaru.map(transform), sannomaru: sannomaru.map(transform) },
    gateCrossings: cuts.map(region => region.polygon.map(transform)),
  }
}

/** Choose a complete enclosure on a real terrace or ridge, before reserving its
 * land. Long faces can follow a contour while the gate faces the lower approach.
 * The same transform moves walls, dry gate cuts, palaces and access paths: terrain
 * adaptation never consists of displacing just the visible moat vertices. */
export function surveyCastleLayout(origin: Point, seed: string, input: CastleSurveyInput) {
  const { terrain } = input
  const dx = terrain.elevation({ x: origin.x + 60, y: origin.y }) - terrain.elevation({ x: origin.x - 60, y: origin.y })
  const dy = terrain.elevation({ x: origin.x, y: origin.y + 60 }) - terrain.elevation({ x: origin.x, y: origin.y - 60 })
  const downhill = Math.atan2(-dy, -dx), grade = Math.hypot(dx, dy) / 120
  const inherited = input.riverTangent ? Math.atan2(input.riverTangent.y, input.riverTangent.x) - Math.PI / 2 : 0
  const preferred = grade > .012 ? [downhill - Math.PI / 2, downhill + Math.PI / 2, inherited] : [inherited, downhill - Math.PI / 2, downhill + Math.PI / 2]
  const angles = [...preferred, inherited + Math.PI, inherited + Math.PI / 2, inherited - Math.PI / 2]
    .filter((angle, i, all) => !all.slice(0, i).some(other => Math.abs(Math.atan2(Math.sin(angle - other), Math.cos(angle - other))) < .01))
  const baseShapes = [{ scaleX: .98, scaleY: .96 }, { scaleX: 1.12, scaleY: .72 }, { scaleX: .82, scaleY: .82 }]
  // The inherited enclosure has its own proportions even on a level terrace.
  // One coherent transform moves every compound, gate, wall and building; it
  // is surveyed below just like the unmodified fallback designs. Seeded
  // proportions never displace vertices after their physical checks.
  const random = seededRandom(`${seed}:castle-site-proportions`), scaleX = .97 + random() * .06, scaleY = .97 + random() * .06
  const shapes = [...baseShapes.map(shape => ({ scaleX: shape.scaleX * scaleX, scaleY: shape.scaleY * scaleY })), ...baseShapes]
  let best: { castle: ReturnType<typeof castleLayout>; score: number; design: EnclosureDesign; relief: number } | null = null
  const bounded = (point: Point) => point.x >= 16 && point.y >= 16 && point.x <= input.width - 16 && point.y <= input.height - 16
  for (const shape of shapes) for (const angle of angles) {
    const design = { ...shape, angle }, castle = castleLayout(origin, seed, undefined, design)
    if (input.waterAreas?.some(area => polygonOverlapsRegion(castle.core, area))) continue
    // Boundary sampling and a genuine interior survey catch tributaries and
    // steep hollows missed by the old eight probes around a 270m circle.
    const samples = [...castle.core]
    for (let i = 0; i < castle.core.length; i++) {
      const a = castle.core[i]!, b = castle.core[(i + 1) % castle.core.length]!, count = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 20)
      for (let j = 1; j < count; j++) samples.push({ x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count })
    }
    const minX = Math.min(...castle.core.map(p => p.x)), maxX = Math.max(...castle.core.map(p => p.x)), minY = Math.min(...castle.core.map(p => p.y)), maxY = Math.max(...castle.core.map(p => p.y))
    for (let y = minY + 10; y < maxY; y += 20) for (let x = minX + 10; x < maxX; x += 20) if (pointInPolygon({ x, y }, castle.core)) samples.push({ x, y })
    if (samples.some(point => !bounded(point) || terrain.waterAt(point) || !Number.isFinite(terrain.elevation(point)) || !Number.isFinite(terrain.slope(point)) || terrain.slope(point) > .20)) continue
    const levels = samples.map(point => terrain.elevation(point)), relief = Math.max(...levels) - Math.min(...levels)
    if (relief > 32) continue
    if (castle.structures.some(building => {
      const levels = building.polygon.map(point => terrain.elevation(point))
      return Math.max(...levels) - Math.min(...levels) > 4.5 || building.polygon.some(point => !Number.isFinite(terrain.slope(point)) || terrain.slope(point) > .15)
    })) continue
    // A gate must open onto a dry, walkable approach, not a bluff or river.
    const inside = castle.gate.inside, outside = castle.gate.outside, gx = outside.x - inside.x, gy = outside.y - inside.y
    const lead = { x: outside.x + gx * 2.4, y: outside.y + gy * 2.4 }
    let approach = true, previous = inside
    for (let i = 0; i <= 10; i++) {
      const point = { x: inside.x + (lead.x - inside.x) * i / 10, y: inside.y + (lead.y - inside.y) * i / 10 }
      if (!bounded(point) || terrain.waterAt(point) || !Number.isFinite(terrain.slope(point)) || !Number.isFinite(terrain.elevation(point)) || terrain.slope(point) > .16 || (i && Math.abs(terrain.elevation(point) - terrain.elevation(previous)) > Math.hypot(point.x - previous.x, point.y - previous.y) * .14 + 1e-8)) { approach = false; break }
      previous = point
    }
    if (!approach) continue
    const gateLevel = terrain.elevation(outside), keepLevel = terrain.elevation(castle.point)
    const compactPenalty = shape.scaleX * shape.scaleY < .7 ? 2.5 : 0
    const score = relief * (grade > .012 ? 1 : .25) + Math.max(0, gateLevel - keepLevel) * 3 + terrain.slope(outside) * 45 + compactPenalty
    if (!best || score < best.score - 1e-8) best = { castle, score, design, relief }
  }
  if (!best) return null
  const dryDitches: Area[] = [], waterMoats: Area[] = []
  for (const area of best.castle.areas) {
    const samples = [...area.polygon, ...(area.holes ?? []).flat()]
    for (const ring of [area.polygon, ...(area.holes ?? [])]) for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!, count = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 12)
      for (let j = 1; j < count; j++) samples.push({ x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count })
    }
    const minX = Math.min(...area.polygon.map(p => p.x)), maxX = Math.max(...area.polygon.map(p => p.x)), minY = Math.min(...area.polygon.map(p => p.y)), maxY = Math.max(...area.polygon.map(p => p.y))
    for (let y = minY + 6; y < maxY; y += 12) for (let x = minX + 6; x < maxX; x += 12) {
      const point = { x, y }
      if (pointInPolygon(point, area.polygon) && !area.holes?.some(hole => pointInPolygon(point, hole))) samples.push(point)
    }
    const levels = samples.map(point => terrain.elevation(point)), lowestBank = Math.min(...levels), relief = Math.max(...levels) - lowestBank
    // A continuous water surface has one level. High-relief defensive ditches
    // are earthworks, not blue water following the hillside uphill and downhill.
    if (!levels.every(Number.isFinite) || relief > 2.5) dryDitches.push({ ...area, id: area.id.replace('moat-', 'castle-dry-ditch-'), kind: 'field', landUse: 'vacant' })
    // Standing-water rendering adds 0.5m. Excavating the surveyed ditch to a
    // fixed level below its lowest bank leaves at least 0.5m of dry freeboard.
    else waterMoats.push({ ...area, waterLevel: lowestBank - 1 })
  }
  return { ...best.castle, areas: waterMoats, grounds: [...best.castle.grounds, ...dryDitches], survey: { ...best.design, relief: best.relief, dryDitches: dryDitches.length, waterMoats: waterMoats.length } }
}
