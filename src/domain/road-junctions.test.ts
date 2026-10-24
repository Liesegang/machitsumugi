import { describe, expect, it } from 'vitest'
import { materializeRoadJunctions, PlanarRoadGraph, roadLength } from './road-graph'
import type { RoadMetadata, SimulatedRoad } from './road-graph'
import { assignRoadTraffic } from './road-traffic'

const point = (x: number, y: number) => ({ x, y })
const metadata = (id: string): RoadMetadata => ({ id, builtYear: 1900, role: 'lane', width: 6, kind: 'local', phase: 'railway', reason: 'surveyed road', constructionCost: 20 })
const parent: SimulatedRoad = { ...metadata('parent'), points: [point(0, 0), point(50.054, 0), point(100, 0)] }
const branch: SimulatedRoad = { ...metadata('branch'), role: 'access', points: [point(50.02, 0), point(50.02, 100)] }

describe('exact physical road junctions across routing lattice boundaries', () => {
  it('retains a newly surveyed T-junction 3.4cm from an older stored vertex', () => {
    const graph = new PlanarRoadGraph()
    graph.add(parent.points, metadata('parent'), false)
    expect(graph.add(branch.points, { ...metadata('branch'), role: 'access' })).not.toBeNull()
    expect(graph.roads[0]!.points.some(p => Math.abs(p.x - 50.02) < 1e-7)).toBe(true)
    expect(roadLength(graph.roads[0]!.points)).toBeCloseTo(100, 9)
    expect(graph.travelTime(point(0, 0), point(50.02, 100))).toBeCloseTo(150.02 / 220, 8)
  })

  it('recovers a saved exact contact without moving geometry or mutating the original routes', () => {
    const roads = structuredClone([parent, branch]), before = JSON.stringify(roads), raw = new PlanarRoadGraph()
    raw.roads.push(...roads)
    const graph = raw.fork(), imported = graph.roads.find(r => r.id === 'parent')!
    expect(imported.points).toContainEqual(branch.points[0])
    expect(roadLength(imported.points)).toBeCloseTo(roadLength(parent.points), 9)
    expect(graph.travelTime(point(0, 0), point(50.02, 100))).toBeCloseTo(150.02 / 220, 8)
    expect(graph.accessibilityFrom(point(0, 0))(point(50.02, 100))).toBeCloseTo(150.02 / 220, 8)
    expect(JSON.stringify(roads)).toBe(before)
    expect(materializeRoadJunctions(materializeRoadJunctions(roads))).toEqual(materializeRoadJunctions(roads))
  })

  it('serves all recorded branch households in traffic assignment without snapping them to another road', () => {
    const roads = structuredClone([parent, branch]), before = JSON.stringify(roads)
    const result = assignRoadTraffic({ roads, cells: [{ point: point(50.02, 90), roadId: 'branch', households: 34 }], destinations: [{ point: point(0, 0), weight: 1 }], year: 2025 })
    expect(result.totalPeakTrips).toBeCloseTo(34 * .36, 9)
    expect(result.unservedPeakTrips).toBe(0)
    expect(result.loads.get('parent')!.peakVehicles).toBeCloseTo(34 * .36, 9)
    expect(JSON.stringify(roads)).toBe(before)
  })

  it('preserves the exact branch contact through a funded replacement alignment', () => {
    const raw = new PlanarRoadGraph()
    raw.roads.push(...structuredClone([parent, branch]))
    const graph = raw.fork()
    const changed = graph.modify('parent', 1955, { points: structuredClone(parent.points), width: 8, reason: 'funded widening', constructionCost: 30 })
    expect(changed!.points).toContainEqual(branch.points[0])
    expect(Number.isFinite(graph.travelTime(point(0, 0), point(50.02, 100)))).toBe(true)
    const old = graph.roadHistory.find(version => version.value.id === 'parent' && version.to === 1955)!
    expect(old.value.points).toContainEqual(branch.points[0])
  })

  it('does not connect a nearby endpoint, an overpass or a controlled mainline', () => {
    for (const other of [
      { ...branch, points: [point(50.02, .03), point(50.02, 100)] },
      { ...branch, level: 1 },
      { ...branch, role: 'expressway' as const, controlledAccess: true },
    ]) {
      const roads = structuredClone([parent, other]), normalized = materializeRoadJunctions(roads)
      expect(normalized).toEqual(roads)
      const result = assignRoadTraffic({ roads, cells: [{ point: point(0, 0), roadId: 'parent', households: 34 }], destinations: [{ point: point(50.02, 100), weight: 1 }], year: 2025 })
      // An elevated/controlled destination is not a surface entrance; the
      // nearest surface street still cannot acquire a false crossing edge.
      expect(result.loads.get('branch')?.peakVehicles ?? 0).toBe(0)
      if (!other.level && !other.controlledAccess) expect(result.unservedPeakTrips).toBeCloseTo(34 * .36, 9)
    }
  })
})
