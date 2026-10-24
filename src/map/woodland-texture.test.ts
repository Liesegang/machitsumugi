import { afterEach, describe, expect, it, vi } from 'vitest'
import { woodlandCrowns } from './woodland-texture'
import { areaColor, DEFAULT_LAYERS, renderMap } from './render'
import { exportMapSvg } from './export'
import { landPaintGroups } from './land-paint'
import { rectangle } from '../domain/geometry'
import type { Area, CityMap } from '../domain/types'

afterEach(() => vi.unstubAllGlobals())
const woodland: Area[] = [{ id: 'land-woodland-1', kind: 'field', landUse: 'woodland', polygon: rectangle(0, 0, 400, 400), holes: [rectangle(150, 150, 100, 100)] }, { id: 'land-woodland-2', kind: 'field', landUse: 'woodland', polygon: rectangle(400, 0, 400, 400) }]
const map: CityMap = { width: 800, height: 400, config: { name: '自然地', seed: 'woods', type: 'post', terrain: 'plain', density: 20, forest: 60, railway: false, stations: 1, arterial: false, facilities: [] }, description: '', areas: woodland, roads: [], buildings: [], facilities: [], districts: [], stations: [], railways: [] }

describe('continuous woodland rendering', () => {
  it('shares deterministic world crowns across a tiled contour without doubling them on computational edges', async () => {
    const expected = [...woodlandCrowns(woodland, true)], arcs: number[][] = [], fills: unknown[] = []
    const state: Record<string, unknown> = { arc: (...args: number[]) => arcs.push(args), fill: () => fills.push(state.fillStyle) }
    const ctx = new Proxy(state, { get: (target, key: string) => target[key] ?? (() => {}) }) as unknown as CanvasRenderingContext2D
    const options = { layers: { ...DEFAULT_LAYERS, buildings: false, roads: false, railway: false, facilities: false, labels: false }, style: 'standard' as const, scale: 1, annotations: [], showSecrets: false }
    renderMap(ctx, map, options)
    expect(landPaintGroups(woodland)).toHaveLength(1)
    expect(fills.filter(fill => fill === areaColor(woodland[0]!, 'standard'))).toHaveLength(1)
    expect(arcs.map(arc => arc.slice(0, 3))).toEqual(expected.map(crown => [crown.x, crown.y, crown.radius]))
    expect([...woodlandCrowns(woodland, true)]).toEqual(expected)
    expect([...woodlandCrowns(woodland, false)].length).toBeGreaterThan(expected.length)
    let svg: Blob | undefined
    vi.stubGlobal('URL', { createObjectURL: (value: Blob) => { svg = value; return 'blob:woods' } })
    vi.stubGlobal('document', { createElement: () => ({ click: () => {}, remove: () => {} }), body: { appendChild: () => {} } })
    vi.stubGlobal('window', { setTimeout: () => {} })
    exportMapSvg(map, options)
    const text = await svg!.text()
    expect(text).toContain('clip-rule="evenodd"')
    expect(text).toContain('M150.00 150.00 L250.00 150.00 L250.00 250.00 L150.00 250.00 Z')
    expect(text.match(/<circle/g)).toHaveLength(expected.length)
    for (const crown of expected.slice(0, 4)) expect(text).toContain(`cx="${crown.x.toFixed(3)}" cy="${crown.y.toFixed(3)}" r="${crown.radius.toFixed(3)}"`)
    arcs.length = 0; renderMap(ctx, map, { ...options, scale: .4 }); expect(arcs).toHaveLength(0)
  })
  it('keeps meadow, sparse woodland and forest distinct in all palettes without outlining clipping tiles', () => {
    for (const style of ['standard', 'mono', 'night'] as const) {
      const colours = [{ ...woodland[0]!, landUse: 'meadow' as const }, woodland[0]!, { ...woodland[0]!, kind: 'forest' as const, landUse: undefined }].map(area => areaColor(area, style))
      expect(new Set(colours).size).toBe(3)
    }
  })
})
