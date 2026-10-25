import { expect, it } from 'vitest'
import { certifyLayoutAccess } from './layout-first-access'
import type { Road } from './types'
it('requires an exact, already open public route through to a real outside endpoint', () => {
  const roads: Road[] = [
    { id: 'through', kind: 'arterial', width: 10, builtYear: 1650, boundaryContinuation: true, points: [{ x: -50, y: 100 }, { x: 100, y: 100 }, { x: 500, y: 100 }] },
    { id: 'school', kind: 'local', width: 5, builtYear: 1875, points: [{ x: 100, y: 100 }, { x: 100, y: 200 }] },
    { id: 'future', kind: 'local', width: 5, builtYear: 1995, points: [{ x: 100, y: 200 }, { x: 300, y: 200 }] },
  ]
  const result = certifyLayoutAccess({ width: 500, height: 500, roads, targets: [
    { id: 'school', point: { x: 100, y: 200 }, builtYear: 1875 },
    { id: 'future-anchor', point: { x: 300, y: 200 }, builtYear: 1875 },
    { id: 'gap', point: { x: 102, y: 200 }, builtYear: 1875 },
  ] })
  expect(result).toEqual({ certified: 1, unserved: ['future-anchor', 'gap'] })
})
