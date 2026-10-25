import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CityMap } from '../domain/types'
import { parseProject } from '../domain/project'
import { exportMapSvg } from './export'
import { DEFAULT_LAYERS, renderMap } from './render'

afterEach(() => vi.unstubAllGlobals())
const map: CityMap = { width: 1000, height: 1000, config: { name: '本町市', seed: 'district-overlay', type: 'castle', terrain: 'plain', density: 80, forest: 0, railway: false, stations: 1, arterial: true, facilities: [] }, description: '', roads: [], buildings: [], areas: [], facilities: [], railways: [], stations: [], districts: [{ id: 'town', kind: 'town', name: '本町', point: { x: 300, y: 300 }, regions: [{ polygon: [{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 500 }, { x: 100, y: 500 }] }] }] }

describe('optional town and ward boundary overlay', () => {
  it('keeps place names visible independently of cadastral boundary strokes in canvas and SVG', async () => {
    const strokes: unknown[] = [], labels: string[] = []
    const state: Record<string, unknown> = { stroke: () => strokes.push(state.strokeStyle), measureText: (text: string) => ({ width: text.length * 8 }), fillText: (text: string) => labels.push(text) }
    const ctx = new Proxy(state, { get: (target, key: string) => target[key] ?? (() => {}) }) as unknown as CanvasRenderingContext2D
    const options = { layers: { ...DEFAULT_LAYERS }, style: 'standard' as const, scale: 1, annotations: [], showSecrets: false }
    renderMap(ctx, map, options)
    expect(labels).toContain('本町')
    expect(strokes).not.toContain('#8a8293')
    let svg: Blob | undefined
    vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { svg = blob; return 'blob:district' } })
    vi.stubGlobal('document', { createElement: () => ({ click: () => {}, remove: () => {} }), body: { appendChild: () => {} } })
    vi.stubGlobal('window', { setTimeout: () => {} })
    exportMapSvg(map, options)
    expect(await svg!.text()).toContain('本町')
    expect(await svg!.text()).not.toContain('stroke="#8a8293"')
    options.layers.districts = true
    renderMap(ctx, map, options)
    expect(strokes).toContain('#8a8293')
    exportMapSvg(map, options)
    expect(await svg!.text()).toContain('stroke="#8a8293"')
    expect(await svg!.text()).toContain('本町')
  })

  it('roundtrips explicit boundary visibility and accepts older archives without the new key', () => {
    const project = { version: 2, config: map.config, annotations: [], style: 'standard', layers: { ...DEFAULT_LAYERS, districts: true } }
    expect(parseProject(JSON.stringify(project)).layers.districts).toBe(true)
    project.layers.districts = false
    expect(parseProject(JSON.stringify(project)).layers.districts).toBe(false)
    const older = Object.fromEntries(Object.entries(project.layers).filter(([key]) => key !== 'districts'))
    expect(parseProject(JSON.stringify({ ...project, layers: older })).layers.districts).toBeUndefined()
  })
})
