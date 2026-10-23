import type { Point, Road } from './types'
import type { RailwayPlan } from './railway-planner'
import { planRailBranch } from './railway-branch.ts'
import type { RailBranchInput, RailwayBranchPlan } from './railway-branch.ts'

export interface RailwayHub { point: Point; demand: number; reason: string }
export interface RailwayNetworkInput {
  inheritedRoads?: Road[]
  width: number; height: number; main: RailwayPlan; terrain: RailBranchInput['terrain']; core?: Point[] | null
  hubs: RailwayHub[]; maxBranches: number
  /** Index is the number of adopted branches; passenger stations are relocated,
   * not invented. Every marginal project includes the loss of a parent station. */
  mainStationOptions?: Point[][]
}
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)
const turn = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))

/** Evaluate inherited settlement hubs against a fixed regional line. Demand and
 * construction costs are explicit relative scenario units, not yen or ridership.
 * An unaffordable/physically impossible branch is omitted; no branch-count target
 * is filled and the already valid parent line is never bent to suggest variety. */
export function planRailwayBranches(input: RailwayNetworkInput): (RailwayBranchPlan & { hub: RailwayHub; benefit: number; parentIndex: number })[] {
  const { points, elevations } = input.main
  const selected: (RailwayBranchPlan & { hub: RailwayHub; benefit: number; parentIndex: number })[] = []
  const mainStations = (branches: number) => input.mainStationOptions?.[branches] ?? [points[0]!, points[Math.floor(points.length / 2)]!, points.at(-1)!]
  const access = (hub: RailwayHub, branches = selected, stations = mainStations(branches.length)) => Math.min(...stations.map(p => distance(p, hub.point)), ...branches.map(branch => distance(branch.terminus!, hub.point) + branch.length * .07 + 350))
  const hubs = input.hubs.map(hub => ({ hub, separation: Math.min(...points.map(p => distance(p, hub.point))) }))
    .filter(candidate => candidate.hub.demand > 0 && candidate.separation >= 1000)
    .map(candidate => ({ ...candidate, benefit: candidate.hub.demand * Math.min(1500, candidate.separation - 180) * .012 }))
    .sort((a, b) => b.benefit - a.benefit)
  for (const candidate of hubs) {
    if (selected.length >= input.maxBranches) break
    if (selected.some(branch => distance(branch.terminus!, candidate.hub.point) < 750)) continue
    // A regional railway feeder does not replace an ordinary short walk to a
    // parent station. Only the uncovered share of an inherited hub can support
    // another project; already served demand is not spent twice.
    const remainingDemand = candidate.hub.demand * Math.max(0, Math.min(1, (access(candidate.hub) - 500) / 900))
    if (remainingDemand < 600) continue
    const junctions: { index: number; start: RailBranchInput['start']; score: number }[] = []
    let lastSample = -Infinity, chainage = 0
    for (let i = 1; i < points.length - 1; i++) {
      chainage += distance(points[i - 1]!, points[i]!)
      if (chainage - lastSample < 85 || chainage < 130) continue
      lastSample = chainage
      const a = points[i - 1]!, p = points[i]!, b = points[i + 1]!, before = distance(a, p), after = distance(p, b)
      if (selected.some(branch => distance(branch.points[0]!, p) < 300)) continue
      const curvature = 2 * ((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / (before * after * distance(a, b) || 1)
      if (Math.abs(curvature) > 1 / 650 || input.terrain.waterAt(p)) continue
      const parentHeading = Math.atan2(b.y - a.y, b.x - a.x), parentGrade = (elevations[i + 1]! - elevations[i - 1]!) / (before + after)
      for (const direction of [1, -1]) {
        const heading = parentHeading + (direction === 1 ? 0 : Math.PI), dx = candidate.hub.point.x - p.x, dy = candidate.hub.point.y - p.y
        const forward = dx * Math.cos(heading) + dy * Math.sin(heading), angle = Math.abs(turn(Math.atan2(dy, dx) - heading))
        if (forward < 130 || angle > Math.PI * .55) continue
        junctions.push({ index: i, start: { point: p, elevation: elevations[i]!, heading, grade: parentGrade * direction, curvature: curvature * direction }, score: distance(p, candidate.hub.point) + angle * 280 + Math.abs(parentGrade) * 3000 + Math.abs(curvature) * 20000 })
      }
    }
    junctions.sort((a, b) => a.score - b.score)
    let best: (RailwayBranchPlan & { parentIndex: number; benefit: number }) | null = null
    const tried: Point[] = []
    for (const junction of junctions) {
      if (tried.some(p => distance(p, junction.start.point) < 170)) continue
      tried.push(junction.start.point)
      const branch = planRailBranch({ width: input.width, height: input.height, terrain: input.terrain, core: input.core, inheritedRoads: input.inheritedRoads, avoidTracks: [points, ...selected.map(branch => branch.points)], start: junction.start, goal: candidate.hub.point, maxNodes: 14_000 })
      if (branch && branch.length >= 1100 && branch.length / distance(junction.start.point, branch.terminus!) < 1.55 && branch.length / candidate.separation < 1.8) {
        const proposal = { ...branch, hub: candidate.hub, parentIndex: junction.index, benefit: 0 }
        // Approximate generalized last-mile cost includes feeder in-vehicle
        // time and a 350m walk-equivalent boarding/transfer penalty. This is an
        // explicit scenario assumption. Positive *and negative* access changes
        // over every disjoint hub are counted, including the removed main stop.
        const benefit = input.hubs.reduce((sum, hub) => sum + hub.demand * (access(hub) - access(hub, selected.concat(proposal), mainStations(selected.length + 1))) * .004, 0)
        if (branch.constructionCost < benefit && (!best || benefit - branch.constructionCost > best.benefit - best.constructionCost)) best = { ...branch, parentIndex: junction.index, benefit }
      }
      if (tried.length >= 4) break
    }
    if (best) selected.push({ ...best, hub: candidate.hub })
  }
  return selected
}
