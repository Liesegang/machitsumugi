import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { planLayoutRailServiceCut, splitLayoutRailServiceFace } from './layout-first-rail-service-cut'
import type { RailServiceCutInput, RailServiceFrontage } from './layout-first-rail-service-cut'
import type { Point, Road } from './types'
import { RoadPlanner } from './road-planner'
import { RailwayRoadConstraints } from './railway-road-constraints'
import { PlanarRoadGraph } from './road-graph'
import { distance, distanceToSegment, polygonArea, rectangle } from './geometry'

const polygon = rectangle(100, 100, 800, 800)
const frontages: RailServiceFrontage[] = polygon.map((a, i) => ({ a, b: polygon[(i + 1) % polygon.length]!, roadId: `public-${i}`, builtYear: 1900, width: 7 }))
const railway = { id: 'track', mode: 'surface' as const, builtYear: 1900, points: [{ x: 0, y: 500 }, { x: 1000, y: 500 }] }
const base = (): RailServiceCutInput => ({ polygon, frontages, railways: [railway], builtYear: 1955, width: 5.6, planner: new RoadPlanner({ width: 1100, height: 1100, areas: [], core: null }), rowAllows: () => true, elevation: () => 0 })

describe('finite real-track service cut', () => {
  it('cuts only between two public perimeter roads, at actual separation and with exact children', () => {
    const input = base(), before = JSON.stringify(input.polygon), result = planLayoutRailServiceCut(input)
    expect(result.cut, JSON.stringify(result.attempts)).not.toBeNull()
    const cut = result.cut!
    expect(cut.fromRoadId).not.toBe(cut.toRoadId)
    for (const point of [cut.points[0]!, cut.points.at(-1)!]) expect(frontages.some(frontage => distanceToSegment(point, frontage.a, frontage.b) < 1e-7)).toBe(true)
    expect(cut.points.every(point => Math.abs(point.y - 500) >= input.width / 2 + 10.5)).toBe(true)
    expect(new RailwayRoadConstraints([railway]).crossings(cut.points)).toHaveLength(0)
    expect(cut.polygons.reduce((area, child) => area + polygonArea(child), 0)).toBeCloseTo(polygonArea(polygon), 5)
    expect(JSON.stringify(input.polygon)).toBe(before)
  })

  it('does not invent perimeter contacts on rail/mask edges, future streets, or controlled roads', () => {
    for (const transform of [
      () => [] as RailServiceFrontage[],
      (list: RailServiceFrontage[]) => list.map(frontage => ({ ...frontage, builtYear: 1975 })),
      (list: RailServiceFrontage[]) => list.map(frontage => ({ ...frontage, controlledAccess: true })),
    ]) expect(planLayoutRailServiceCut({ ...base(), frontages: transform(frontages) }).cut).toBeNull()
  })

  it('keeps all ordinary width/ROW/rail/grade guards and caps the alternative count at four', () => {
    for (const blocked of ['width', 'ROW', 'rail', 'grade'] as const) {
      const input = base(), result = planLayoutRailServiceCut({ ...input,
        planner: { validate: () => blocked !== 'width', railwayWidthAllows: () => blocked !== 'rail' },
        rowAllows: () => blocked !== 'ROW', elevation: blocked === 'grade' ? point => point.x * .2 : () => 0,
      })
      expect(result.cut).toBeNull()
      expect(result.attempts.some(attempt => attempt.reason === blocked), JSON.stringify(result.attempts)).toBe(true)
      expect(result.attempts).toHaveLength(4)
    }
  })

  it('allows at most one fallback on each side, then leaves children to normal mixed fabric', () => {
    const first = planLayoutRailServiceCut(base()).cut!
    const next = planLayoutRailServiceCut({ ...base(), usedSides: [{ railwayId: first.railwayId, side: first.side }] }).cut!
    expect(next.side).toBe(-first.side)
    expect(planLayoutRailServiceCut({ ...base(), usedSides: [{ railwayId: first.railwayId, side: 1 }, { railwayId: first.railwayId, side: -1 }] }).cut).toBeNull()
  })

  it('tolerates numerical endpoint residue while rejecting exterior and self-crossing paths', () => {
    const exact = splitLayoutRailServiceFace(polygon, [{ x: 100 + 1e-12, y: 400 }, { x: 900, y: 400 }])
    expect(exact).not.toBeNull()
    expect(exact!.reduce((area, child) => area + polygonArea(child), 0)).toBeCloseTo(polygonArea(polygon), 5)
    expect(splitLayoutRailServiceFace(polygon, [{ x: 100, y: 500 }, { x: 500, y: 50 }, { x: 900, y: 500 }])).toBeNull()
    expect(splitLayoutRailServiceFace(polygon, [{ x: 100, y: 500 }, { x: 700, y: 700 }, { x: 300, y: 700 }, { x: 900, y: 500 }])).toBeNull()
  })

  it('partitions the final canonical path and rejects moved public contacts before adoption', () => {
    const rejected = planLayoutRailServiceCut({ ...base(), canonicalize: () => null })
    expect(rejected.cut).toBeNull()
    expect(rejected.attempts).toHaveLength(4)
    const moved = planLayoutRailServiceCut({ ...base(), canonicalize: points => [{ x: points[0]!.x + 1, y: points[0]!.y }, ...points.slice(1)] })
    expect(moved.cut).toBeNull()
    let finalPath: Point[] = []
    const accepted = planLayoutRailServiceCut({ ...base(), canonicalize: points => {
      finalPath = [points[0]!, { x: (points[0]!.x + points.at(-1)!.x) / 2, y: (points[0]!.y + points.at(-1)!.y) / 2 }, points.at(-1)!]
      return finalPath
    } })
    expect(accepted.cut!.points).toEqual(finalPath)
    expect(accepted.cut!.polygons.reduce((area, child) => area + polygonArea(child), 0)).toBeCloseTo(polygonArea(polygon), 5)
  })

  it.each([['fixtures/layout-first-rail-service-06.json', 181205.261], ['fixtures/layout-first-rail-service-07.json', 214172.840]])('finds a separate, no-new-gate cut in the ACTUAL saved east-station face %s', (filename, area) => {
    const fixture = JSON.parse(readFileSync(new URL(`./${filename}`, import.meta.url), 'utf8')) as Pick<RailServiceCutInput, 'polygon' | 'frontages' | 'railways' | 'builtYear' | 'width'> & { existingRoads: Road[] }
    const bounds = fixture.polygon.reduce((value, point) => ({ x: Math.max(value.x, point.x), y: Math.max(value.y, point.y) }), { x: 0, y: 0 })
    const planner = new RoadPlanner({ width: Math.ceil(bounds.x + 100), height: Math.ceil(bounds.y + 100), areas: [], core: null })
    planner.setRailwayCorridors([...fixture.railways]); planner.setRailwayRoadNetwork(fixture.existingRoads)
    const constraints = new RailwayRoadConstraints([...fixture.railways]); constraints.updateExistingRoads(fixture.existingRoads)
    const result = planLayoutRailServiceCut({ ...fixture, planner, rowAllows: () => true, elevation: () => 0 })
    expect(result.cut, JSON.stringify(result.attempts)).not.toBeNull()
    const cut = result.cut!
    expect(polygonArea([...fixture.polygon])).toBeCloseTo(area, 2)
    expect(constraints.crossings(cut.points)).toHaveLength(0)
    expect(planner.railwayWidthAllows(cut.points, .01, cut.width, 'lane')).toBe(true)
    for (const [point, id] of [[cut.points[0]!, cut.fromRoadId], [cut.points.at(-1)!, cut.toRoadId]] as [Point, string][]) expect(fixture.frontages.some(frontage => frontage.roadId === id && frontage.builtYear <= cut.builtYear && distanceToSegment(point, frontage.a, frontage.b) < 1e-7)).toBe(true)
    expect(cut.polygons.reduce((area, child) => area + polygonArea(child), 0)).toBeCloseTo(polygonArea([...fixture.polygon]), 4)
    expect(distance(cut.points[0]!, cut.points.at(-1)!)).toBeGreaterThan(100)
    const graph = new PlanarRoadGraph(), metadata = { id: 'saved-public-perimeter', width: 8, kind: 'local' as const, role: 'collector' as const, builtYear: 1900, phase: 'test', reason: 'saved physical face boundary', constructionCost: 0 }
    graph.add([...fixture.polygon, fixture.polygon[0]!], metadata, false)
    const staged = graph.fork(), normalized = staged.add(cut.points, { ...metadata, id: 'staged-service', width: cut.width, builtYear: cut.builtYear })
    expect(normalized).not.toBeNull()
    expect(splitLayoutRailServiceFace(fixture.polygon, normalized!.points)).not.toBeNull()
    const adopted = graph.add(normalized!.points, { ...metadata, id: 'accepted-service', width: cut.width, builtYear: cut.builtYear })
    expect(adopted).not.toBeNull()
    const actualChildren = splitLayoutRailServiceFace(fixture.polygon, adopted!.points)
    expect(actualChildren).not.toBeNull()
    expect(actualChildren!.reduce((area, child) => area + polygonArea(child), 0)).toBeCloseTo(polygonArea([...fixture.polygon]), 4)
    // This proves saved geometry and crossing policy only. Native terrain,
    // land reservations and longitudinal grade remain for an authorized run.
  })
})
