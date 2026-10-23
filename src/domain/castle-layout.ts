import ClipperLib from 'clipper-lib'
import { corridorPolygon, polygonOverlapsRegion, rectangle, seededRandom, subtractRegions } from './geometry'
import type { Area, Building, Point, Road } from './types'

/** A fictional flatland castle: an offset honmaru, an enclosing ninomaru,
 * broad wall faces, a separate outer ditch and two dry gate crossings.
 * Small repeated square notches are not a substitute for these enclosures.
 */
export function castleLayout(origin: Point, seed: string, riverTangent?: Point) {
  const random = seededRandom(`${seed}:castle-enclosures`)
  const angle = (riverTangent ? Math.atan2(riverTangent.y, riverTangent.x) - Math.PI / 2 : 0) + (random() - .5) * .18
  const sx = .90 + random() * .12, sy = .90 + random() * .12, shear = (random() - .5) * .12
  const c = Math.cos(angle), s = Math.sin(angle)
  const transform = (p: Point): Point => {
    const x = p.x * sx + p.y * shear, y = p.y * sy
    return { x: origin.x + x * c - y * s, y: origin.y + x * s + y * c }
  }
  const shape = (pairs: number[][]) => pairs.map(([x, y]) => ({ x: x!, y: y! }))
  // Long nonparallel faces follow a surveyed enclosure. The honmaru sits at
  // one side, leaving a usable second bailey rather than concentric icons.
  const coreLocal = shape([[-222,-156],[-166,-197],[80,-180],[191,-118],[218,88],[150,174],[-130,196],[-215,114]])
  const honmaru = shape([[-145,-125],[-50,-143],[45,-114],[64,-30],[24,48],[-119,63],[-158,-15]])
  const offset = new ClipperLib.ClipperOffset(2, .5 * 100)
  const path = honmaru.map(p => ({ X: Math.round(p.x * 100), Y: Math.round(p.y * 100) }))
  if (!ClipperLib.Clipper.Orientation(path)) path.reverse()
  offset.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const outlines: ClipperLib.Paths = []
  offset.Execute(outlines, 25 * 100)
  const outer = outlines[0]!.map(p => ({ x: p.X / 100, y: p.Y / 100 }))
  // Gate crossings are cut out of actual water geometry, not painted on top.
  const innerGate = corridorPolygon({ x: 32, y: 18 }, { x: 110, y: 53 }, 7)
  const outerGate = corridorPolygon({ x: -20, y: 121 }, { x: -20, y: 198 }, 8)
  const moat = subtractRegions({ polygon: outer, holes: [honmaru] }, [{ polygon: innerGate }])
  // The surviving outer ditch wraps the second bailey on a different course.
  const ditch = shape([[-205,-53],[-202,111],[-140,177],[108,162],[185,103],[179,-69],[162,-65],[167,94],[99,143],[-132,157],[-184,104],[-188,-54]])
  const ditches = subtractRegions({ polygon: ditch }, [{ polygon: outerGate }])
  const areas: Area[] = [...moat, ...ditches].map((region, i) => ({
    id: i < moat.length ? `moat-inner-${i}` : `moat-outer-remnant-${i - moat.length}`,
    kind: 'water', polygon: region.polygon.map(transform),
    ...(region.holes ? { holes: region.holes.map(ring => ring.map(transform)) } : {}),
  }))
  const building = (id: string, x: number, y: number, w: number, h: number, height: number): Building => ({ id, polygon: rectangle(x, y, w, h).map(transform), kind: 'public', height, builtYear: 1650 })
  const structures = [
    building('castle-keep', -123, -104, 30, 25, 5),
    building('castle-small-keep', -85, -99, 18, 16, 3),
    building('castle-palace', -96, -35, 76, 42, 1),
    building('castle-ninomaru-palace', 74, 81, 52, 36, 1),
  ].filter(b => !areas.some(area => polygonOverlapsRegion(b.polygon, area)))
  const innerWall = new ClipperLib.ClipperOffset(2, .5 * 100)
  innerWall.AddPath(path, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const wallInners: ClipperLib.Paths = []
  innerWall.Execute(wallInners, -3.5 * 100)
  const wall = subtractRegions({ polygon: honmaru, holes: [wallInners[0]!.map(p => ({ x: p.X / 100, y: p.Y / 100 }))] }, [{ polygon: innerGate }])
  // The open compounds have distinct functions: an earth courtyard around the
  // honmaru palace and a smaller working court at the second-bailey offices.
  // Stone-wall strips follow the same surveyed enclosure and the same gate cut.
  const grounds: Area[] = [
    { id: 'castle-courtyard-honmaru', kind: 'field', landUse: 'vacant', polygon: honmaru.map(transform) },
    { id: 'castle-courtyard-ninomaru', kind: 'field', landUse: 'vacant', polygon: shape([[60,70],[139,70],[139,104],[110,132],[60,132]]).map(transform) },
    ...wall.map((region, i): Area => ({ id: `castle-wall-honmaru-${i}`, kind: 'field', landUse: 'vacant', polygon: region.polygon.map(transform), ...(region.holes ? { holes: region.holes.map(ring => ring.map(transform)) } : {}) })),
  ]
  const route = (id: string, pairs: number[][], width: number): Road => ({ id, points: shape(pairs).map(transform), width, kind: 'local', role: 'access', builtYear: 1650, reason: '城郭の門・曲輪・御殿を結ぶ城内通路' })
  // Each branch shares an exact vertex with the gate-to-palace route. These
  // paths cross water only where the moat geometry has an actual dry gate.
  const paths = [
    route('castle-path-main', [[-20,182],[-20,132],[65,132],[65,90],[65,65],[110,53],[32,18],[-10,18],[-58,14]], 4),
    route('castle-path-ninomaru', [[65,90],[70,90]], 3.5),
    route('castle-path-keep', [[-58,14],[-108,14],[-108,-67],[-106,-75]], 3.5),
    route('castle-path-small-keep', [[-108,-67],[-75,-67],[-75,-79]], 3.5),
  ]
  return {
    core: coreLocal.map(transform), areas, structures, grounds, paths,
    gate: { inside: transform({ x: -20, y: 182 }), outside: transform({ x: -20, y: 207 }) },
    point: transform({ x: -108, y: -91 }),
    enclosures: { honmaru: honmaru.map(transform), ninomaru: coreLocal.map(transform) },
    gateCrossings: [innerGate.map(transform), outerGate.map(transform)],
  }
}
