import { describe, expect, it } from 'vitest'
import { civicTransportAcquisitions } from './civic-transport'
import { rectangle } from './geometry'
import type { Road } from './types'

const campus = rectangle(100, 100, 108, 88)
const road = (id: string, year: number, x = 150): Road => ({ id, builtYear: year, width: 8, kind: 'local', points: [{ x, y: 0 }, { x, y: 300 }] })
describe('dated civic land acquisition by actual transport', () => {
  it('finds the first real later crossing without changing the earlier survey', () => {
    const roads = [road('later-1975', 1975, 170), road('first-1955', 1955)]
    expect(civicTransportAcquisitions(roads, [], 1900)(campus, 1875, 'own-access')).toBeNull()
    expect(civicTransportAcquisitions(roads, [], 2025)(campus, 1875, 'own-access')).toEqual({ year: 1955, routeId: 'first-1955', mode: 'road' })
    expect(civicTransportAcquisitions(roads, [], 2025)(campus, 1980, 'own-access')).toBeNull()
  })
  it('ignores the site entrance, mere boundary touches and separated viaducts', () => {
    expect(civicTransportAcquisitions([road('own-access', 1875), road('touch', 1955, 96), { ...road('overpass', 1960), level: 1 }], [], 2025)(campus, 1875, 'own-access')).toBeNull()
  })
  it('records a later railway right-of-way as an acquisition too', () => {
    expect(civicTransportAcquisitions([], [{ id: 'rail', name: '鉄道', builtYear: 1900, points: [{ x: 150, y: 0 }, { x: 150, y: 300 }] }], 2025)(campus, 1875, 'own-access')).toEqual({ year: 1900, routeId: 'rail', mode: 'railway' })
  })
})
