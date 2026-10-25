import { expect, it } from 'vitest'
import { designateLayoutThroughRoads, layoutThroughRoadHistory } from './layout-first-road-designations'
import type { Road } from './types'
const programme = (roads: Road[]): Road[] => roads.map(road => road.width >= 6.8 ? { ...road, throughRouteId: 'surveyed-test-corridor' } : road)
it('continues the designation over a real bridge and splits an unused side tail', () => {
  const roads: Road[] = programme([
    { id: 'west', kind: 'arterial', width: 12, boundaryContinuation: true, points: [{ x: -30, y: 50 }, { x: 50, y: 50 }] },
    { id: 'bridge', kind: 'local', width: 7, role: 'bridge', bridge: true, points: [{ x: 50, y: 50 }, { x: 100, y: 50 }, { x: 150, y: 50 }] },
    { id: 'east', kind: 'arterial', width: 12, boundaryContinuation: true, points: [{ x: 100, y: 50 }, { x: 230, y: 50 }] },
    { id: 'lane', kind: 'local', width: 5, points: [{ x: 50, y: 50 }, { x: 50, y: 100 }] },
  ])
  const result = designateLayoutThroughRoads(roads, 200, 150)
  expect(result.find(road => road.id === 'bridge-through-1')).toMatchObject({ kind: 'arterial', width: 7, points: [{ x: 50, y: 50 }, { x: 100, y: 50 }] })
  expect(result.find(road => road.id === 'bridge-local-2')).toMatchObject({ kind: 'local', width: 7 })
  expect(result.find(road => road.id === 'lane')).toEqual(roads[3])
})

it('demotes a wide dead end when only one real external continuation exists, without shrinking pavement or mutating its input', () => {
  const roads: Road[] = programme([
    { id: 'one-exit', kind: 'arterial', role: 'highway', width: 14, boundaryContinuation: true, points: [{ x: -30, y: 50 }, { x: 70, y: 50 }] },
    { id: 'yellow-dead-end', kind: 'arterial', role: 'highway', width: 14, points: [{ x: 70, y: 50 }, { x: 170, y: 50 }] },
  ])
  const before = JSON.stringify(roads), result = designateLayoutThroughRoads(roads, 200, 150)
  expect(result.every(road => road.kind === 'local' && road.role === 'collector' && road.width === 14)).toBe(true)
  expect(JSON.stringify(roads)).toBe(before)
})

it('does not call two continuations on the same crop edge a through route', () => {
  const roads: Road[] = [{ throughRouteId: 'same-edge', id: 'west-loop', kind: 'arterial', width: 12, boundaryContinuation: true, points: [{ x: -20, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 110 }, { x: -20, y: 110 }] }]
  expect(designateLayoutThroughRoads(roads, 200, 150)[0]!.kind).toBe('local')
})

it('keeps only an actual through path yellow and demotes its wide side spur', () => {
  const roads: Road[] = programme([
    { id: 'main', kind: 'arterial', role: 'highway', width: 14, boundaryContinuation: true, points: [{ x: -20, y: 70 }, { x: 100, y: 70 }, { x: 220, y: 70 }] },
    { id: 'spur', kind: 'arterial', role: 'highway', width: 14, points: [{ x: 100, y: 70 }, { x: 100, y: 130 }] },
  ])
  const result = designateLayoutThroughRoads(roads, 200, 150)
  expect(result.find(road => road.id === 'main')).toMatchObject({ kind: 'arterial', role: 'highway', width: 14 })
  expect(result.find(road => road.id === 'spur')).toMatchObject({ kind: 'local', role: 'collector', width: 14 })
})

it('finds a valid through component even when an earlier exit is isolated', () => {
  const roads: Road[] = programme([
    { id: 'isolated-north', kind: 'arterial', width: 12, boundaryContinuation: true, points: [{ x: 50, y: -20 }, { x: 50, y: 20 }] },
    { id: 'connected-main', kind: 'local', width: 12, boundaryContinuation: true, points: [{ x: -20, y: 100 }, { x: 220, y: 100 }] },
    { id: 'controlled', kind: 'arterial', role: 'expressway', width: 20, controlledAccess: true, points: [{ x: 20, y: 140 }, { x: 180, y: 140 }] },
  ])
  const result = designateLayoutThroughRoads(roads, 200, 150)
  expect(result.find(road => road.id === 'isolated-north')!.kind).toBe('local')
  expect(result.find(road => road.id === 'connected-main')!.kind).toBe('arterial')
  expect(result.find(road => road.id === 'controlled')).toEqual(roads[2])
})

it('updates an 1850 road designation only after its second external connection opens in 1975', () => {
  const roads: Road[] = programme([
    { id: 'old-west', kind: 'arterial', role: 'highway', width: 12, builtYear: 1850, boundaryContinuation: true, points: [{ x: -20, y: 70 }, { x: 100, y: 70 }] },
    { id: 'new-east', kind: 'arterial', role: 'highway', width: 12, builtYear: 1975, boundaryContinuation: true, points: [{ x: 100, y: 70 }, { x: 220, y: 70 }] },
  ])
  const before = JSON.stringify(roads), history = layoutThroughRoadHistory(roads, 200, 150)
  const west = history.filter(version => version.value.id === 'old-west')
  expect(west).toHaveLength(2)
  expect(west[0]).toMatchObject({ from: 1850, to: 1975, value: { id: 'old-west', kind: 'local', role: 'collector', builtYear: 1850, width: 12 } })
  expect(west[0]!.value.modifiedYear).toBeUndefined()
  expect(west[1]).toMatchObject({ from: 1975, value: { id: 'old-west', kind: 'arterial', role: 'highway', builtYear: 1850, modifiedYear: 1975, width: 12 } })
  for (const version of west) expect(version.value.points).toEqual(roads[0]!.points)
  // This is the generator's growth-count rule: the designation update does
  // not create another road. Only the actual new east connection counts.
  expect(history.filter(version => version.from === 1975 && version.value.modifiedYear !== version.from).map(version => version.value.id)).toEqual(['new-east'])
  expect(JSON.stringify(roads)).toBe(before)
})

it('retains stable physical piece ids across dated changes and leaves an unused tail local', () => {
  const roads: Road[] = programme([
    { id: 'west-tail', kind: 'arterial', width: 12, builtYear: 1850, boundaryContinuation: true, points: [{ x: -20, y: 70 }, { x: 100, y: 70 }, { x: 160, y: 70 }] },
    { id: 'north', kind: 'arterial', width: 12, builtYear: 1975, boundaryContinuation: true, points: [{ x: 100, y: 70 }, { x: 100, y: -20 }] },
  ])
  const history = layoutThroughRoadHistory(roads, 200, 150), first = history.filter(version => version.value.id === 'west-tail-designation-1'), tail = history.filter(version => version.value.id === 'west-tail-designation-2')
  expect(first.map(version => version.value.kind)).toEqual(['local', 'arterial'])
  expect(first[0]!.value.points).toEqual(first[1]!.value.points)
  expect(first.every(version => version.value.builtYear === 1850 && version.value.width === 12)).toBe(true)
  expect(tail).toHaveLength(1)
  expect(tail[0]!.value).toMatchObject({ kind: 'local', builtYear: 1850, width: 12, points: [{ x: 100, y: 70 }, { x: 160, y: 70 }] })
})

it('preserves the independently surveyed alignment even when a shorter local street joins two points on it', () => {
  const roads: Road[] = [
    { id: 'regional', throughRouteId: 'regional-1', kind: 'local', width: 12, boundaryContinuation: true, points: [{ x: -20, y: 70 }, { x: 50, y: 70 }, { x: 50, y: 20 }, { x: 150, y: 20 }, { x: 150, y: 70 }, { x: 220, y: 70 }] },
    { id: 'short-local', kind: 'local', width: 12, points: [{ x: 50, y: 70 }, { x: 150, y: 70 }] },
  ]
  const result = designateLayoutThroughRoads(roads, 200, 150)
  expect(result.find(road => road.id === 'regional')).toMatchObject({ kind: 'arterial', throughRouteId: 'regional-1', points: roads[0]!.points })
  expect(result.find(road => road.id === 'short-local')!.kind).toBe('local')
  const history = layoutThroughRoadHistory(roads, 200, 150)
  expect(history.find(version => version.value.id === 'regional')!.value.throughRouteId).toBe('regional-1')
})
