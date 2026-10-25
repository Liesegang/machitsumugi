import { expect, it } from 'vitest'
import { designateLayoutThroughRoads } from './layout-first-road-designations'
import type { Road } from './types'
it('continues the designation over a real bridge and splits an unused side tail', () => {
  const roads: Road[] = [
    { id: 'west', kind: 'arterial', width: 12, boundaryContinuation: true, points: [{ x: -30, y: 50 }, { x: 50, y: 50 }] },
    { id: 'bridge', kind: 'local', width: 7, role: 'bridge', bridge: true, points: [{ x: 50, y: 50 }, { x: 100, y: 50 }, { x: 150, y: 50 }] },
    { id: 'east', kind: 'arterial', width: 12, boundaryContinuation: true, points: [{ x: 100, y: 50 }, { x: 230, y: 50 }] },
    { id: 'lane', kind: 'local', width: 5, points: [{ x: 50, y: 50 }, { x: 50, y: 100 }] },
  ]
  const result = designateLayoutThroughRoads(roads, 200, 150)
  expect(result.find(road => road.id === 'bridge-through-1')).toMatchObject({ kind: 'arterial', width: 7, points: [{ x: 50, y: 50 }, { x: 100, y: 50 }] })
  expect(result.find(road => road.id === 'bridge-local-2')).toMatchObject({ kind: 'local', width: 7 })
  expect(result.find(road => road.id === 'lane')).toEqual(roads[3])
})
