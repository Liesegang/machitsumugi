import { describe, expect, it } from 'vitest'
import { transportHillslope } from './hillslope-transport'

describe('conservative hillslope solid transport', () => {
  it('moves the same solid volume into the sea that leaves the dry bank', () => {
    const n = 7, elevation = new Float32Array(n * n).fill(-10), alluvium = new Float64Array(n * n)
    elevation[3 * n + 3] = 10; alluvium[3 * n + 3] = 20
    const result = transportHillslope({ elevation, alluvium, columns: n, rows: n, cellSize: 50, coefficient: .1, seaLevel: 0 })
    expect(result.elevation[3 * n + 3]).toBe(2)
    for (const i of [17, 23, 25, 31]) { expect(result.elevation[i]).toBe(-8); expect(result.alluvium[i]).toBe(2) }
    expect(result.alluvium[24]).toBe(12)
    expect(result.bedrockSourceVolume).toBe(0)
    expect(result.netTerrainVolume).toBe(0)
    expect(result.alluvium.reduce((s, v) => s + v, 0)).toBe(20)
  })
  it('accounts for freshly mobilized bedrock and keeps a no-flux outer boundary', () => {
    const n = 7, elevation = new Float32Array(n * n), alluvium = new Float64Array(n * n)
    elevation[3 * n + 3] = 10; alluvium[3 * n + 3] = 1
    const result = transportHillslope({ elevation, alluvium, columns: n, rows: n, cellSize: 25, coefficient: .1, seaLevel: 0 })
    expect(result.transferredVolume).toBe(4 * 625)
    expect(result.bedrockSourceVolume).toBe(3 * 625)
    expect(result.alluvium.reduce((s, v) => s + v, 0) * 625).toBe(625 + result.bedrockSourceVolume)
    expect(result.netTerrainVolume).toBe(0)
    for (let i = 0; i < n; i++) { expect(result.elevation[i]).toBe(elevation[i]); expect(result.elevation[i * n]).toBe(elevation[i * n]) }
  })
})
