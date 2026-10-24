import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportMapSvg } from './export'
import { DEFAULT_LAYERS, renderMap } from './render'
import { subwayInk, SUBWAY_DASH, SUBWAY_LINE_WIDTH } from './railway-style'
import type { CityMap } from '../domain/types'

afterEach(() => vi.unstubAllGlobals())
const map: CityMap = { width: 2100, height: 1600, config: { name: '地下鉄都市', seed: 'metro', type: 'newtown', terrain: 'plain', density: 80, forest: 0, railway: false, stations: 1, arterial: true, subway: true, facilities: [] }, description: '', roads: [], buildings: [], areas: [], facilities: [], districts: [], railways: [{ id: 'subway', name: '本線', mode: 'subway', builtYear: 1965, points: [{ x: 100, y: 500 }, { x: 2000, y: 500 }] }], stations: [{ id: 'stop', name: '中央駅', mode: 'subway', railwayId: 'subway', point: { x: 1000, y: 500 }, entrance: { x: 1000, y: 515 }, buildingPolygon: [{ x: 997, y: 512 }, { x: 1003, y: 512 }, { x: 1003, y: 515 }, { x: 997, y: 515 }], builtYear: 1965 }] }

describe('subway map and portable exports', () => {
  it('uses the same subway width/dash/colour in the canvas used by PNG and the SVG, rather than surface railway ties', async () => {
    const strokes: { ink: unknown; width: unknown; dash: number[] }[] = [], labels: string[] = []
    let dash: number[] = []
    const state: Record<string, unknown> = { setLineDash: (values: number[]) => { dash = values }, stroke: () => strokes.push({ ink: state.strokeStyle, width: state.lineWidth, dash: [...dash] }), measureText: (s: string) => ({ width: s.length * 8 }), fillText: (s: string) => labels.push(s) }
    const ctx = new Proxy(state, { get: (target, key: string) => target[key] ?? (() => {}) }) as unknown as CanvasRenderingContext2D
    const options = { layers: DEFAULT_LAYERS, style: 'standard' as const, scale: 1, annotations: [], showSecrets: false }
    renderMap(ctx, map, options)
    expect(strokes).toContainEqual({ ink: subwayInk('standard'), width: SUBWAY_LINE_WIDTH, dash: [...SUBWAY_DASH] })
    expect(strokes.some(s => s.dash.join() === '5,4')).toBe(false)
    expect(labels).toContain('中央駅')
    let svg: Blob | undefined
    vi.stubGlobal('URL', { createObjectURL: (value: Blob) => { svg = value; return 'blob:svg' } })
    vi.stubGlobal('document', { createElement: () => ({ click: () => {}, remove: () => {} }), body: { appendChild: () => {} } })
    vi.stubGlobal('window', { setTimeout: () => {} })
    exportMapSvg(map, options)
    const text = await svg!.text()
    expect(text).toContain('data-mode="subway"')
    expect(text).toContain(`stroke="${subwayInk('standard')}" stroke-width="${SUBWAY_LINE_WIDTH}" stroke-dasharray="7 4"`)
    expect(text).toContain('<circle data-mode="subway"'); expect(text).toContain('中央駅')
    expect(text).toContain('M997.00 512.00 L1003.00 512.00 L1003.00 515.00 L997.00 515.00 Z')
  })
})
