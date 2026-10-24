import { afterEach, expect, it, vi } from 'vitest'
import { areaColor, DEFAULT_LAYERS, renderMap } from './render'
import { rectangle } from '../domain/geometry'
import type { Area, CityMap } from '../domain/types'

afterEach(() => vi.unstubAllGlobals())

it('retains castle walls, courts and dry ditches over contours while suppressing other land-cover fills', () => {
  const areas: Area[] = [
    { id: 'land-meadow-0', kind: 'field', landUse: 'meadow', polygon: rectangle(10, 10, 10, 10) },
    { id: 'forest', kind: 'forest', polygon: rectangle(30, 10, 10, 10) },
    { id: 'historic-core', kind: 'park', polygon: rectangle(50, 10, 10, 10) },
    { id: 'castle-courtyard-honmaru', kind: 'field', landUse: 'vacant', polygon: rectangle(70, 10, 10, 10) },
    { id: 'castle-wall-ninomaru-0', kind: 'field', landUse: 'vacant', polygon: rectangle(90, 10, 10, 10) },
    { id: 'castle-dry-ditch-inner-0', kind: 'field', landUse: 'vacant', polygon: rectangle(110, 10, 10, 10) },
  ]
  const map: CityMap = { width: 200, height: 200, config: { name: '城下町', seed: 'contour', type: 'castle', terrain: 'plain', density: 0, forest: 0, railway: false, stations: 0, arterial: false, facilities: [] }, description: '',
    terrainSurface: { columns: 2, rows: 2, cellSize: 200, elevations: [30, 30, 30, 30] }, areas, roads: [], buildings: [], facilities: [], districts: [], railways: [], stations: [] }
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }) }) })
  for (const style of ['standard', 'mono', 'night'] as const) for (const contours of [false, true]) {
    const fills: { x: number; ink: string }[] = []; let x = -1
    const state: Record<string, unknown> = { moveTo: (value: number) => { x = value }, fill: (rule?: CanvasFillRule) => { if (rule === 'evenodd') fills.push({ x, ink: state.fillStyle as string }) } }
    const ctx = new Proxy(state, { get: (target, key: string) => target[key] ?? (() => {}) }) as unknown as CanvasRenderingContext2D
    renderMap(ctx, map, { layers: { ...DEFAULT_LAYERS, labels: false, buildings: false, roads: false, railway: false, facilities: false }, scale: 1, style, contours, annotations: [], showSecrets: false })
    expect(fills).toEqual(areas.filter(a => !contours || a.id.startsWith('castle-')).map(a => ({ x: a.polygon[0]!.x, ink: areaColor(a, style) })))
  }
})
