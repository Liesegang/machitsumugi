import { describe, expect, it } from 'vitest'
import { routeDrainage } from './hydrology'

describe('path-based drainage direction', () => {
  it('follows a 13 degree plane within one cell instead of locking into a grid direction', () => {
    const n = 121, step = 50, raw = new Float32Array(n * n), tangent = Math.tan(13 * Math.PI / 180)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) raw[y * n + x] = 500 - x - y * tangent
    const trace = (method: 'd8' | 'd8-ltd') => {
      const result = routeDrainage(raw, n, n, step, method), start = 20 * n + 5
      let cell = start
      while (cell % n < 110 && result.flowTo[cell]! >= 0) cell = result.flowTo[cell]!
      return { error: Math.abs(Math.floor(cell / n) - 20 - (cell % n - 5) * tangent), result }
    }
    const d8 = trace('d8'), ltd = trace('d8-ltd')
    expect(d8.error).toBeGreaterThan(20)
    expect(ltd.error).toBeLessThan(1)
    expect(ltd.result.outletArea).toBe(n * n * step ** 2)
  })
  it('converges across a shallow valley floor and preserves the catchment', () => {
    const n = 101, raw = new Float32Array(n * n)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) raw[y * n + x] = 200 - y + .012 * (x - 50) ** 2
    const d8 = routeDrainage(raw, n, n, 50, 'd8'), ltd = routeDrainage(raw, n, n, 50)
    // Analytic parabolic flow approaches the axis asymptotically. Compare the
    // finite-width valley-floor transect, not one arbitrarily selected pixel.
    const transect = (values: Float64Array) => values.slice(90 * n + 45, 90 * n + 56).reduce((sum, value) => sum + value, 0)
    expect(transect(ltd.accumulatedArea)).toBeGreaterThan(transect(d8.accumulatedArea) * 3)
    expect(ltd.outletArea).toBe(n * n * 2500)
    const rank = new Int32Array(n * n)
    ltd.order.forEach((cell, index) => { rank[cell] = index })
    ltd.flowTo.forEach((next, cell) => { if (next >= 0) { expect(rank[next]).toBeGreaterThan(rank[cell]!); expect(ltd.hydroDEM[next]).toBeLessThanOrEqual(ltd.hydroDEM[cell]!) } })
  })
})
