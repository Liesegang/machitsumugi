import { describe, expect, it } from 'vitest'
import { shoppingStreetHistory } from './commercial-history'
import { rectangle } from './geometry'
import type { Building, TimelineVersion } from './types'

describe('historical shopping street', () => {
  it('appears only after three real frontages open and disappears when one is acquired', () => {
    const buildings: TimelineVersion<Building>[] = [1700, 1750, 1800].map((from, i) => ({ from, ...(i === 0 ? { to: 1955 } : {}), value: { id: `shop-${i}`, parcelId: `p-${i}`, builtYear: from, polygon: rectangle(100 + i * 30, 20, 20, 20), kind: 'commercial', height: 2 } }))
    const history = shoppingStreetHistory({ buildings,
      parcels: [0, 1, 2].map(i => ({ from: 1700, value: { id: `p-${i}`, roadId: 'street', createdYear: 1700, polygon: rectangle(100 + i * 30, 10, 25, 35), entrance: { x: 100 + i * 30, y: 50 }, use: 'commercial' } })),
      roads: [{ from: 1700, value: { id: 'street', points: [{ x: 0, y: 50 }, { x: 500, y: 50 }], width: 6, kind: 'local' } }], name: '商店街', throughYear: 2025,
    })
    expect(history).toHaveLength(1)
    expect(history[0]!.from).toBe(1800)
    expect(history[0]!.to).toBe(1955)
  })
})
