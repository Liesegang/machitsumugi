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
  it('transports an uplifted perimeter towards the interior without creating or losing material outside the domain', () => {
    const n = 7, elevation = new Float32Array(n * n).fill(-10), alluvium = new Float64Array(n * n)
    elevation[0] = 10; alluvium[0] = 1
    const result = transportHillslope({ elevation, alluvium, columns: n, rows: n, cellSize: 25, coefficient: .1, seaLevel: 0 })
    expect(result.elevation[0]).toBe(6)
    expect(result.elevation[1]).toBe(-8)
    expect(result.elevation[n]).toBe(-8)
    expect(result.elevation[n + 1]).toBe(-10)
    expect(result.transferredVolume).toBe(4 * 625)
    expect(result.bedrockSourceVolume).toBe(3 * 625)
    expect(result.alluvium.reduce((sum, z) => sum + z, 0) * 625).toBe(625 + result.bedrockSourceVolume)
    expect(result.netTerrainVolume).toBe(0)
    expect(result.alluvium.every(z => z >= 0)).toBe(true)
  })
  it('retains the same conservative faces in a single-row or single-column domain', () => {
    for (const [columns, rows] of [[1, 3], [3, 1]]) {
      const result = transportHillslope({ elevation: new Float32Array([10, 0, 0]), alluvium: new Float64Array(3), columns: columns!, rows: rows!, cellSize: 50, coefficient: .1, seaLevel: 0 })
      expect(result.elevation).toEqual(new Float32Array([9, 1, 0]))
      expect(result.transferredVolume).toBe(2500)
      expect(result.bedrockSourceVolume).toBe(2500)
      expect(result.netTerrainVolume).toBe(0)
    }
  })
})
