import { describe, expect, it } from 'vitest'
import { surveyUniversityCampus } from './civic-campus'
import { RoadPlanner } from './road-planner'
import { corridorPolygon, distanceToSegment, pointInPolygon, polygonOverlapsRegion, polygonsOverlap, rectangle } from './geometry'
import { surveyDevelopmentSite } from './development-terrain'
import type { Building, Point } from './types'

function hillside(grade = .08, budget = 15000, span = [220, 180], waterAt: (point: Point) => boolean = () => false) {
  const campus = rectangle(300 - span[0]! / 2, 300 - span[1]! / 2, span[0]!, span[1]!), terrain = { elevation: (p: Point) => 100 + p.x * grade, slope: () => grade, waterAt, bridgeSites: [] }
  return { campus, center: { x: 300, y: 300 }, entrance: { x: 300, y: 300 - span[1]! / 2 + 3 }, along: { x: 1, y: 0 }, across: { x: 0, y: 1 }, year: 1965, name: '丘陵大学', suffix: '', ...terrain, budget, canPlace: (polygon: Point[]) => polygon.every(p => pointInPolygon(p, campus)),
    plan: (a: Point, b: Point, buildings: Building[]) => new RoadPlanner({ width: 600, height: 600, core: null, areas: [], terrain, exactLandCost: true, landCost: p => !pointInPolygon(p, campus) || buildings.some(building => pointInPolygon(p, building.polygon) || building.polygon.some((a, i) => distanceToSegment(p, a, building.polygon[(i + 1) % building.polygon.length]!) < 1.6)) ? Infinity : 0 }).plan(a, b, { role: 'access', width: 2.8, alignment: 'planned', maximumGrade: .14, maxNodes: 1800 }),
  }
}

describe('an optional university on individually surveyed hillside pads', () => {
  it('builds several contour-aligned low buildings, with a real path from the entrance to every building', () => {
    const input = hillside(), campus = surveyUniversityCampus(input)!
    expect(campus).not.toBeNull(); expect(campus.buildings.length).toBeGreaterThanOrEqual(3)
    expect(campus.paths).toHaveLength(campus.buildings.length + 1)
    expect(campus.cost).toBeLessThan(input.budget)
    expect(campus.paths[0]!.points[0]).toEqual(input.entrance)
    for (const building of campus.buildings) {
      expect(building.builtYear).toBe(1965)
      expect(surveyDevelopmentSite(input, building.polygon[0]!, building.polygon).viable).toBe(true)
      for (const path of campus.paths) for (let i = 1; i < path.points.length; i++) expect(polygonOverlapsRegion(building.polygon, { polygon: corridorPolygon(path.points[i - 1]!, path.points[i]!, 1.4) })).toBe(false)
      const linked = campus.paths.some(path => Math.min(...building.polygon.slice(1).map((b, i) => distanceToSegment(path.points.at(-1)!, building.polygon[i]!, b))) < 3)
      expect(linked).toBe(true)
    }
    for (let i = 0; i < campus.buildings.length; i++) for (let j = i + 1; j < campus.buildings.length; j++) expect(polygonsOverlap(campus.buildings[i]!.polygon, campus.buildings[j]!.polygon)).toBe(false)
  })
  it('does not flatten an unsupported mountainside or create a campus without sufficient public capital', () => {
    expect(surveyUniversityCampus(hillside(.32))).toBeNull()
    expect(surveyUniversityCampus(hillside(.08, 200))).toBeNull()
  })
  it('rejects a site where its buildings or connecting paths would occupy water', () => {
    const input = hillside()
    expect(surveyUniversityCampus({ ...input, canPlace: polygon => input.canPlace(polygon) && polygon.every(p => p.x < 320) })).toBeNull()
  })
  it('uses a larger valid site as a connected academic district, with shared facilities instead of an enlarged empty reserve', () => {
    const input = hillside(0, 50000, [320, 260]), rejected: string[] = [], campus = surveyUniversityCampus({ ...input, onReject: reason => rejected.push(reason) })!
    expect(rejected).toEqual([])
    expect(campus).not.toBeNull()
    expect(campus.buildings).toHaveLength(7)
    expect(campus.buildings.some(building => building.name?.includes('体育館'))).toBe(true)
    expect(campus.buildings.some(building => building.name?.includes('学生会館'))).toBe(true)
    expect(campus.paths).toHaveLength(campus.buildings.length + 1)
    expect(campus.cost).toBeLessThan(input.budget)
    for (const building of campus.buildings) {
      expect(building.polygon.every(point => pointInPolygon(point, input.campus))).toBe(true)
      for (const path of campus.paths) for (let i = 1; i < path.points.length; i++) expect(polygonOverlapsRegion(building.polygon, { polygon: corridorPolygon(path.points[i - 1]!, path.points[i]!, 1.4) })).toBe(false)
    }
  })
  it('keeps a dry seven-building programme unplaced when the only entrance path crosses water', () => {
    const input = hillside(0, 50000, [320, 260], p => p.y > 205 && p.y < 215), rejected: string[] = []
    expect(surveyUniversityCampus({ ...input, onReject: reason => rejected.push(reason) })).toBeNull()
    expect(rejected).toEqual(['entrance-path'])
  })
})
