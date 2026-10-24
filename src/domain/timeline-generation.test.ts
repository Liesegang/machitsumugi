import { expect, it } from 'vitest'
import { generateCity } from './generator'
import type { TerrainModel } from './terrain'
import { sliceCityAtYear } from './timeline'
import { parseProject, portableProject } from './project'

it('archives a complete real generator run and roundtrips a previous century without future civic stock', () => {
  // A deliberately flat dry physical fixture isolates the chronology contract;
  // erosion quality is tested in the terrain suites, not rerun for this test.
  const terrain: TerrainModel = {
    areas: [], elevation: () => 20, slope: () => 0, waterAt: () => false, bridgeSites: [], cityOrigin: { x: 2000, y: 1500 }, landform: () => 'terrace', wetness: () => 0, terrainCost: () => 1, cultivable: () => false, bankDistance: () => Infinity, channelAt: () => null, rivers: [], bridgeCandidates: [],
    hydrology: { columns: 10, rows: 10, resolution: 1000, extent: 9000, rawDEM: new Float32Array(100).fill(20), frame: { worldAnchor: { x: 4500, y: 4500 }, localAnchor: { x: 2000, y: 1500 }, angle: 0, mirrored: false }, erosion: { iterations: 0, elapsedYears: 0, terrainBalanceError: 0 }, sediment: { erodedSourceVolume: 0, storedVolume: 0, exportedVolume: 0, massBalanceError: 0 } } as unknown as TerrainModel['hydrology'],
  }
  const map = generateCity({ name: '履歴町', seed: 'chronology-fixture', type: 'post', terrain: 'plain', density: 0, forest: 0, railway: false, stations: 1, arterial: false, facilities: ['school'], settlement: 'village', targetYear: 2025 }, undefined, undefined, () => terrain)
  expect(map.timeline!.throughYear).toBe(2025)
  expect(map.facilities.some(f => f.kind === 'school')).toBe(true)
  const past = sliceCityAtYear(map, 1800)
  expect(past.facilities.some(f => f.kind === 'school')).toBe(false)
  expect(past.buildings.some(b => b.id.includes('school'))).toBe(false)
  expect(past.timeline).toBe(map.timeline)
  const project = { version: 2 as const, config: past.config, snapshot: past, annotations: [], layers: { roads: true, buildings: true, terrain: true, labels: true, facilities: true, railway: true, grid: false }, style: 'standard' as const }
  const restored = parseProject(JSON.stringify(portableProject(project))).snapshot!
  expect(restored.year).toBe(1800)
  expect(sliceCityAtYear(restored, 2025).facilities.some(f => f.kind === 'school')).toBe(true)
  expect(restored.timeline!.areas.length).toBeLessThan(75 * map.areas.length)
}, 15_000)
