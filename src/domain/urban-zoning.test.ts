import { expect, it } from 'vitest'
import { createUrbanZoning } from './urban-zoning'
const zoning = createUrbanZoning({ center: { x: 0, y: 0 }, stations: [{ id: 'station', name: '駅', point: { x: 1400, y: 1000 } }], roads: [{ id: 'highway', width: 14, kind: 'arterial', builtYear: 1955, points: [{ x: 0, y: 600 }, { x: 3000, y: 600 }] }], centers: [{ point: { x: 2500, y: 2000 }, kind: 'industrial', activeYear: 1930, catchment: 500 }] })
it('keeps future stations and roads out of historic planning', () => {
  expect(zoning({ x: 1400, y: 1000 }, 1800).kind).toBe('residential-low')
  expect(zoning({ x: 1400, y: 1000 }, 2025).kind).toBe('station-centre')
  expect(zoning({ x: 2500, y: 630 }, 1930).kind).toBe('residential-low')
  expect(zoning({ x: 2500, y: 630 }, 2025).kind).toBe('roadside-mixed')
})
it('separates quiet housing, mixed frontages and the actual industrial district', () => {
  expect(zoning({ x: 2500, y: 2000 }, 1900).industrialShare).toBeLessThan(.1)
  expect(zoning({ x: 2500, y: 2000 }, 2025).industrialShare).toBeGreaterThan(.5)
  expect(zoning({ x: 2900, y: 2800 }, 2025).maximumFloors).toBe(3)
  expect(zoning({ x: 2500, y: 630 }, 2025).retailShare).toBeGreaterThan(zoning({ x: 2900, y: 2800 }, 2025).retailShare * 10)
})
it('keeps flat mountain station basins viable but does not project station intensity up a scarp', () => {
  const input = { center: { x: 3000, y: 3000 }, stations: [{ id: 's', name: '盆地駅', point: { x: 0, y: 0 } }], roads: [] }
  const low = createUrbanZoning({ ...input, terrain: { slope: () => 0, elevation: () => 30 } })
  const high = createUrbanZoning({ ...input, terrain: { slope: () => 0, elevation: () => 1330 } })
  const scarp = createUrbanZoning({ ...input, terrain: { slope: () => 0, elevation: p => p.x > 100 ? 120 : 0 } })
  const point = { x: 200, y: 0 }
  expect(high(point, 2025)).toEqual(low(point, 2025))
  expect(high(point, 2025).kind).toBe('station-centre')
  expect(scarp(point, 2025).kind).toBe('residential-low')
})
