import { describe, expect, it } from 'vitest'
import type { Road } from './types'
import { distance, distanceToSegment, rectangle } from './geometry'
import { PlanarRoadGraph, extractStreetBlocks } from './road-graph'
import { RoadPlanner } from './road-planner'
import { layoutNeighborhoodHasStreetFace, proposeLayoutNeighborhoodLinks } from './layout-first-neighborhood-links'

const sites = [{ id: 'west-neighbourhood', point: { x: 200, y: 600 }, builtYear: 1900 }, { id: 'station-gate', point: { x: 700, y: 600 }, builtYear: 1900 }]
const roads: Road[] = [
  { id: 'west-old-road', kind: 'local', role: 'collector', width: 8, builtYear: 1650, points: [{ x: 200, y: 100 }, { x: 200, y: 1100 }] },
  { id: 'station-frontage', kind: 'local', role: 'collector', width: 7, builtYear: 1955, points: [{ x: 700, y: 100 }, { x: 700, y: 1100 }] },
]

describe('connections between existing neighbourhood streets', () => {
  it('proposes several separated contacts on real roads with no zone-circle geometry', () => {
    const before = JSON.stringify({ roads, sites }), links = proposeLayoutNeighborhoodLinks({ roads, sites })
    expect(links).toHaveLength(3)
    for (const link of links) {
      const from = roads.find(road => road.id === link.from.roadId)!, to = roads.find(road => road.id === link.to.roadId)!
      expect(distanceToSegment(link.from.point, from.points[0]!, from.points[1]!)).toBeLessThan(1e-8)
      expect(distanceToSegment(link.to.point, to.points[0]!, to.points[1]!)).toBeLessThan(1e-8)
      expect(link.builtYear).toBe(1955)
    }
    for (let i = 1; i < links.length; i++) expect(distance(links[0]!.from.point, links[i]!.from.point)).toBeGreaterThanOrEqual(150)
    expect(proposeLayoutNeighborhoodLinks({ roads, sites })).toEqual(links)
    expect(JSON.stringify({ roads, sites })).toBe(before)
  })

  it('forms several actual blocks between neighbourhoods only after real links are accepted', () => {
    const graph = new PlanarRoadGraph()
    for (const road of [...roads, { id: 'old-connecting-street', kind: 'local' as const, role: 'collector' as const, width: 8, builtYear: 1650, points: [{ x: 200, y: 1100 }, { x: 700, y: 1100 }] }]) graph.add(road.points, { ...road, builtYear: road.builtYear!, role: 'collector', reason: 'fixture actual public street', phase: 'survey', constructionCost: 0 }, false)
    expect(extractStreetBlocks(graph.roads)).toHaveLength(0)
    const links = proposeLayoutNeighborhoodLinks({ roads: graph.roads, sites })
    expect(links.length).toBeGreaterThanOrEqual(2)
    // A proposal has no authority to create land or faces by itself.
    expect(extractStreetBlocks(graph.roads)).toHaveLength(0)
    for (const [index, link] of links.entries()) graph.add([link.from.point, link.to.point], { id: `accepted-link-${index}`, kind: 'local', role: 'collector', width: link.width, builtYear: link.builtYear, reason: 'accepted physical connection', phase: 'survey', constructionCost: 0 })
    const faces = extractStreetBlocks(graph.roads)
    expect(faces.length).toBeGreaterThanOrEqual(2)
    expect(sites.every(site => layoutNeighborhoodHasStreetFace(site, faces))).toBe(true)
  })

  it('leaves water-crossing proposals unbuilt when the normal full-width survey rejects them', () => {
    const water = { id: 'creek', kind: 'water' as const, polygon: rectangle(420, 0, 40, 1200) }
    const planner = new RoadPlanner({ width: 1000, height: 1200, areas: [water], core: null, terrain: { elevation: () => 12, slope: () => 0, waterAt: p => p.x >= 420 && p.x <= 460, bridgeSites: [] } })
    const links = proposeLayoutNeighborhoodLinks({ roads, sites })
    expect(links.length).toBeGreaterThanOrEqual(2)
    expect(links.every(link => !planner.validate([link.from.point, link.to.point], link.width))).toBe(true)
    expect(layoutNeighborhoodHasStreetFace(sites[0]!, [])).toBe(false)
  })

  it('does not manufacture closure from one road or controlled/elevated alignments', () => {
    expect(proposeLayoutNeighborhoodLinks({ roads: [roads[0]!], sites })).toEqual([])
    expect(proposeLayoutNeighborhoodLinks({ roads: [roads[0]!, { ...roads[1]!, controlledAccess: true }], sites })).toEqual([])
    expect(proposeLayoutNeighborhoodLinks({ roads: [roads[0]!, { ...roads[1]!, level: 1 }], sites })).toEqual([])
  })

  it('uses existing closed frontage to restrict outer-loop fallback to genuinely isolated sites', () => {
    const face = rectangle(200, 400, 500, 400)
    expect(layoutNeighborhoodHasStreetFace(sites[0]!, [face])).toBe(true)
    expect(layoutNeighborhoodHasStreetFace(sites[1]!, [face])).toBe(true)
    expect(layoutNeighborhoodHasStreetFace({ id: 'isolated', point: { x: 1700, y: 500 }, builtYear: 1900 }, [face])).toBe(false)
    const needle = [{ x: 100, y: 450 }, { x: 500, y: 500 }, { x: 100, y: 550 }]
    expect(layoutNeighborhoodHasStreetFace({ id: 'needle-tip', point: { x: 500, y: 500 }, builtYear: 1900 }, [needle])).toBe(false)
  })
})
