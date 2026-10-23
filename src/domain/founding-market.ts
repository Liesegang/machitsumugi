import type { Point } from './types'
import type { RoadRole } from './road-graph'
import type { RoadPlanner } from './road-planner'

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Survey the land outside the actual oriented enclosure, rather than assuming
 * that its southern bounding box is the town gate. A nearby tributary can put
 * that arbitrary point on another bank despite a suitable castle site. */
export function foundingMarketGates(input: {
  core: Point[]; center: Point; terminals: Point[]; planner: Pick<RoadPlanner, 'suitable' | 'hasDryCorridor'>; role: RoadRole; width: number
}): Point[] {
  const { core, terminals, planner, role, width } = input
  const signedArea = core.reduce((sum, a, i) => { const b = core[(i + 1) % core.length]!; return sum + a.x * b.y - a.y * b.x }, 0)
  const outward = signedArea >= 0 ? 1 : -1
  const candidates: { point: Point; connections: number; reach: number }[] = []
  for (let i = 0; i < core.length; i++) {
    const a = core[i]!, b = core[(i + 1) % core.length]!, length = distance(a, b)
    if (length < Math.max(55, width * 4)) continue
    const point = { x: (a.x + b.x) / 2 + (b.y - a.y) / length * 72 * outward, y: (a.y + b.y) / 2 - (b.x - a.x) / length * 72 * outward }
    if (!planner.suitable(point, width) || candidates.some(other => distance(point, other.point) < 65)) continue
    const connections = terminals.filter(terminal => planner.hasDryCorridor(point, terminal, role, width))
    if (connections.length) candidates.push({ point, connections: connections.length, reach: connections.reduce((sum, terminal) => sum + distance(point, terminal), 0) / connections.length + distance(point, input.center) })
  }
  return candidates.sort((a, b) => b.connections - a.connections || a.reach - b.reach || a.point.x - b.point.x || a.point.y - b.point.y).map(candidate => candidate.point)
}
