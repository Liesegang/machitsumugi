import { describe, expect, it } from 'vitest'
import { advancePlannedNeighborhood, canCommitPlannedNeighborhood, plannedNeighborhoodContains, plannedNeighborhoodDemand, plannedNeighborhoodStreets, canSurveyInfillChord } from './planned-neighborhood'
import type { NeighborhoodCell, PlannedNeighborhood } from './planned-neighborhood'
import { PlanarRoadGraph, extractStreetBlocks } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { Area } from './types'

function committedDistrict(options: { budget?: number; completed?: number; angle?: number; cells?: NeighborhoodCell[]; areas?: Area[]; landCost?: () => number } = {}) {
  const center = { x: 900, y: 700 }, graph = new PlanarRoadGraph(), planner = new RoadPlanner({ width: 1800, height: 1500, core: null, areas: options.areas ?? [], landCost: options.landCost })
  const district: PlannedNeighborhood = { center, angle: options.angle ?? .31, year: 1955, completed: options.completed ?? 4 }
  const streets = plannedNeighborhoodStreets(center, district.angle)
  graph.add([{ x: 400, y: 700 }, center], { id: 'approach', phase: 'station', builtYear: 1955, role: 'collector', width: 10, kind: 'local', reason: 'station approach', constructionCost: 0 }, false)
  for (let i = 0; i < district.completed; i++) {
    const street = streets[i]!
    graph.add([street.from, street.to], { id: `committed-${i}`, phase: 'suburban', builtYear: 1960, role: street.role, width: street.width, kind: 'local', reason: 'earlier funded spine', constructionCost: 0 })
  }
  const cells = options.cells ?? [{ point: { x: 930, y: 710 }, households: 80, capacity: 100, landValue: .2 }]
  let budget = options.budget ?? 20_000, planned = 0
  return {
    graph, planner, district, cells,
    get budget() { return budget },
    get planned() { return planned },
    contribute(amount: number) { budget += amount },
    tick(year: number, unmetHouseholds = 0) {
      const result = advancePlannedNeighborhood({
        district, year, unmetHouseholds, budget, cells,
        nearest: point => graph.nearest(point, 3)?.point ?? null,
        suitable: (point, width) => planner.suitable(point, width),
        plan: (from, street) => { planned++; return planner.plan(from, street.to, { role: street.role, width: street.width, alignment: 'planned', maxNodes: 2400 }) },
        commit: (route, street, maximumCost) => {
          if (route.cost > maximumCost || !planner.validate(route.points, street.width, route.bridgeLength > 0) || !planner.railwayAllows(route.points, street.role)) return null
          const added = graph.add(route.points, { id: `funded-${year}-${graph.roads.length}`, phase: 'suburban', builtYear: year, role: street.role, width: street.width, kind: 'local', reason: 'funded district street', constructionCost: route.cost })
          if (!added) return null
          budget -= route.cost
          return route.cost
        },
      })
      district.completed = result.completed
      return result
    },
  }
}

describe('fundable local readjustment surveys', () => {
  it('shares the committed programme with urban post towns while preserving the original creation limits', () => {
    const input = { year: 1960, unmetHouseholds: 100, populationFalling: false, type: 'post' as const, settlement: 'metropolis' as const, targetHouseholds: 1500, districtCount: 0, lastProjectYear: 1945 }
    expect(canCommitPlannedNeighborhood(input)).toBe(true)
    expect(canCommitPlannedNeighborhood({ ...input, settlement: 'regional-city' })).toBe(true)
    expect(canCommitPlannedNeighborhood({ ...input, year: 1950 })).toBe(false)
    expect(canCommitPlannedNeighborhood({ ...input, settlement: 'village' })).toBe(false)
    expect(canCommitPlannedNeighborhood({ ...input, type: 'newtown', settlement: 'village', targetHouseholds: 100 })).toBe(false)
    expect(canCommitPlannedNeighborhood({ ...input, unmetHouseholds: 0 })).toBe(false)
    expect(canCommitPlannedNeighborhood({ ...input, populationFalling: true })).toBe(false)
    expect(canCommitPlannedNeighborhood({ ...input, districtCount: 2 })).toBe(false)
    expect(canCommitPlannedNeighborhood({ ...input, lastProjectYear: 1955 })).toBe(false)
    expect(canCommitPlannedNeighborhood({ ...input, type: 'newtown', districtCount: 2 })).toBe(true)
    expect(canCommitPlannedNeighborhood({ ...input, type: 'newtown', districtCount: 3 })).toBe(false)
    // Once selected, progression depends on this occupied physical district,
    // not whether the containing city began as a post town or a new town.
    const estate = committedDistrict(), districts = canCommitPlannedNeighborhood(input) ? [estate.district] : []
    expect(districts.map(() => estate.tick(1965).accepted)).toEqual([2])
    const noDistricts = canCommitPlannedNeighborhood({ ...input, unmetHouseholds: 0 }) ? [estate.district] : []
    const before = estate.graph.roads.length
    for (const _district of noDistricts) estate.tick(1970)
    expect(estate.graph.roads).toHaveLength(before)
  })
  it('connects every scheduled street to earlier streets and closes usable blocks within one local district', () => {
    const center = { x: 900, y: 700 }, graph = new PlanarRoadGraph()
    graph.add([{ x: 400, y: 700 }, center], { id: 'approach', phase: 'station', builtYear: 1955, role: 'collector', width: 10, kind: 'local', reason: 'station approach', constructionCost: 100 }, false)
    for (const [i, street] of plannedNeighborhoodStreets(center, .31).entries()) {
      const road = graph.add([street.from, street.to], { id: `estate-${i}`, phase: 'suburban', builtYear: 1960 + i, role: street.role, width: street.width, kind: 'local', reason: 'funded district street', constructionCost: 100 })
      expect(road, `disconnected scheduled street ${i}`).not.toBeNull()
      expect(graph.travelTime(center, street.to)).toBeLessThan(Infinity)
      expect(street.to.x).toBeGreaterThan(400); expect(street.to.x).toBeLessThan(1400)
    }
    expect(extractStreetBlocks(graph.roads).length).toBeGreaterThanOrEqual(12)
    expect(graph.roads.filter(road => road.role === 'collector')).toHaveLength(5)
  })
  it('finishes occupied committed blocks with real dated roads and existing funds after citywide demand is met', () => {
    const estate = committedDistrict(), initialRoads = estate.graph.roads.length, initialBalance = estate.budget, cellsBefore = structuredClone(estate.cells)
    expect(extractStreetBlocks(estate.graph.roads)).toHaveLength(0)
    let spent = 0
    for (let year = 1965; year <= 2000; year += 5) {
      const before = estate.budget, progress = estate.tick(year)
      expect(progress.accepted).toBe(2)
      expect(progress.spent).toBeCloseTo(before - estate.budget, 8)
      expect(estate.budget).toBeGreaterThanOrEqual(0)
      spent += progress.spent
      for (const road of estate.graph.roads.slice(-progress.accepted)) {
        expect(road.builtYear).toBe(year)
        expect(estate.planner.validate(road.points, road.width, !!road.bridge)).toBe(true)
        expect(estate.graph.travelTime(estate.district.center, road.points.at(-1)!)).toBeLessThan(Infinity)
      }
      // The first funded outside links close blocks before the inner rows.
      if (year === 1975) expect(extractStreetBlocks(estate.graph.roads).length).toBeGreaterThanOrEqual(2)
    }
    expect(estate.district.completed).toBe(20)
    expect(estate.graph.roads.length - initialRoads).toBe(16)
    expect(extractStreetBlocks(estate.graph.roads).length).toBeGreaterThanOrEqual(12)
    expect(spent).toBeCloseTo(initialBalance - estate.budget, 8)
    expect(estate.graph.roads.reduce((sum, road) => sum + road.constructionCost, 0)).toBeCloseTo(spent, 8)
    expect(estate.cells).toEqual(cellsBefore)
    expect(estate.tick(2005).accepted).toBe(0)
  })
  it('does not complete an empty estate using residents in neighbouring old-town land outside its rotated boundary', () => {
    const center = { x: 900, y: 700 }, angle = Math.PI / 4
    const oldTown = { point: { x: center.x + 400 * Math.cos(angle), y: center.y + 400 * Math.sin(angle) }, households: 500, capacity: 600, landValue: .5 }
    const empty = { point: center, households: 0, capacity: 150, landValue: .4 }
    const estate = committedDistrict({ angle, cells: [oldTown, empty] }), before = estate.graph.roads.length
    expect(plannedNeighborhoodContains(oldTown.point, estate.district)).toBe(false)
    expect(plannedNeighborhoodDemand(estate.district, estate.cells)).toEqual({ households: 0, unusedCapacity: 150 })
    expect(estate.tick(1965).accepted).toBe(0)
    expect(estate.graph.roads).toHaveLength(before)
    expect(estate.planned).toBe(0)
    expect(estate.budget).toBe(20_000)
    // An empty but already connected district can still answer genuine unmet demand.
    expect(estate.tick(1970, 100).accepted).toBe(2)
  })
  it('keeps the unused capacity of partially occupied land and counts existing residents even on lower-valued land', () => {
    const district = { center: { x: 900, y: 700 }, angle: .31 }
    const cells = [
      { point: district.center, households: 4, capacity: 20, landValue: .2 },
      { point: { x: 905, y: 700 }, households: 3, capacity: 30, landValue: .01 },
    ]
    expect(plannedNeighborhoodDemand(district, cells)).toEqual({ households: 7, unusedCapacity: 16 })
    const estate = committedDistrict({ cells })
    expect(estate.tick(1965).accepted).toBe(2)
    expect(estate.cells.map(cell => cell.households)).toEqual([4, 3])
  })
  it('defers unaffordable streets without losing their place, and never borrows funds or builds in the commitment year', () => {
    const estate = committedDistrict({ budget: 50 }), initialRoads = estate.graph.roads.length
    const deferred = estate.tick(1965)
    expect(deferred).toMatchObject({ completed: 4, accepted: 0, spent: 0 })
    expect(estate.graph.roads).toHaveLength(initialRoads)
    expect(estate.planned).toBe(0)
    expect(estate.budget).toBe(50)
    estate.contribute(1000)
    const funded = estate.tick(1970)
    expect(funded.accepted).toBe(2)
    expect(estate.budget).toBeCloseTo(1050 - funded.spent, 8)
    expect(estate.budget).toBeGreaterThanOrEqual(0)
    const opening = committedDistrict({ completed: 0 })
    expect(opening.tick(1955, 100).accepted).toBe(0)
    expect(opening.tick(1950, 100).accepted).toBe(0)
    expect(opening.planned).toBe(0)
  })
  it('also defers after an actual ownership-cost survey exceeds the available balance', () => {
    const estate = committedDistrict({ budget: 400, landCost: () => 4 }), before = estate.graph.roads.length
    expect(estate.tick(1965)).toMatchObject({ completed: 4, accepted: 0, spent: 0 })
    expect(estate.planned).toBe(1)
    expect(estate.graph.roads).toHaveLength(before)
    expect(estate.budget).toBe(400)
    estate.contribute(3000)
    expect(estate.tick(1970).accepted).toBe(2)
    expect(estate.budget).toBeGreaterThanOrEqual(0)
  })
  it('keeps the full pavement-width water survey when completing a district', () => {
    const angle = .31, at = (u: number, v: number) => ({ x: 900 + u * Math.cos(angle) - v * Math.sin(angle), y: 700 + u * Math.sin(angle) + v * Math.cos(angle) })
    // The proposed centreline is dry, but a straight 6.5m section would pave
    // over the adjacent water. Only a physically resurveyed route may pass.
    const estate = committedDistrict({ completed: 12, angle, areas: [{ id: 'ditch', kind: 'water', polygon: [at(-250, -147.8), at(-150, -147.8), at(-150, -145.8), at(-250, -145.8)] }] })
    const street = plannedNeighborhoodStreets(estate.district.center, angle)[12]!, before = estate.graph.roads.length
    expect(estate.planner.waterAt(at(-200, -150))).toBe(false)
    expect(estate.planner.validate([street.from, street.to], street.width)).toBe(false)
    const progress = estate.tick(1965)
    expect(progress.accepted).toBe(2)
    for (const road of estate.graph.roads.slice(before)) expect(estate.planner.validate(road.points, road.width, !!road.bridge)).toBe(true)
  })
  it('does not straighten historical streets, hill roads or a chord that cannot serve the proposed land', () => {
    const input = { site: { x: 100, y: 6 }, from: { x: 0, y: 0 }, to: { x: 200, y: 0 }, frontageDepth: 30, year: 1970, slope: () => .01 }
    expect(canSurveyInfillChord(input)).toBe(true)
    expect(canSurveyInfillChord({ ...input, year: 1750 })).toBe(false)
    expect(canSurveyInfillChord({ ...input, slope: () => .09 })).toBe(false)
    expect(canSurveyInfillChord({ ...input, site: { x: 100, y: 50 } })).toBe(false)
  })
})
