import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, generateCity } from '../generator';
import type { Building, CityType, FacilityKind } from '../types';
import { bounds, contains, overlapsRegion, pointLineDistance, segmentCross } from './map-geometry';

const fixtures = new Map<string, ReturnType<typeof generateCity>>();
export function fixture(config: Parameters<typeof generateCity>[0]) {
  const key = JSON.stringify(config);
  if (!fixtures.has(key)) fixtures.set(key, generateCity(config));
  return fixtures.get(key)!;
}

// Each city type lives in its own test file so CI can schedule complete worlds
// independently. Fixtures are shared only within that file; no extra worlds are built.
export function registerCityTypeCases(type: CityType) {
  const preset = { id: type };
  describe('Japanese city generation', { timeout: 1_200_000 }, () => {
    it(`${preset.id}: respects every facility checkbox, including the historical origin`, () => {
      const empty = fixture({ ...DEFAULT_CONFIG, type: preset.id, density: 0, facilities: [] });
      expect(empty.facilities).toEqual([]);
      expect(empty.areas.filter(a => a.id === 'historic-core').every(a => !a.name)).toBe(true);
      const all: FacilityKind[] = ['shrine', 'school', 'hospital', 'police', 'shop', 'park', 'castle', 'port', 'onsen'];
      const full = fixture({ ...DEFAULT_CONFIG, type: preset.id, density: 0, facilities: all });
      expect([...new Set([...full.facilities.map(f => f.kind), ...full.unplacedFacilities!.map(f => f.kind)])].sort()).toEqual([...all].sort());
      for (const rejected of full.unplacedFacilities!) {
        expect(full.facilities.some(f => f.kind === rejected.kind)).toBe(false);
        expect(rejected.reason.length).toBeGreaterThan(10);
      }
      if (preset.id === 'castle' || preset.id === 'temple') expect(empty.areas.some(a => a.id === 'historic-core')).toBe(true);
    });

    it(`${preset.id}: no building footprint intersects another at maximum density`, () => {
      const map = fixture({ ...DEFAULT_CONFIG, type: preset.id, era: 'railway', density: 100, forest: 0 });
      const index = new Map<string, Building[]>();
      const collisions: string[] = [];
      for (const building of map.buildings) {
        const bb = bounds(building.polygon), checked = new Set<string>();
        const keys: string[] = [];
        for (let x = Math.floor(bb.x0 / 40); x <= Math.floor(bb.x1 / 40); x++) for (let y = Math.floor(bb.y0 / 40); y <= Math.floor(bb.y1 / 40); y++) {
          const key = `${x}:${y}`; keys.push(key);
          for (const other of index.get(key) ?? []) {
            if (checked.has(other.id)) continue;
            checked.add(other.id);
            const a = building.polygon, b = other.polygon;
            if (a.some(p => contains(b, p)) || b.some(p => contains(a, p)) || a.some((p, i) => b.some((q, j) => segmentCross(p, a[(i + 1) % a.length]!, q, b[(j + 1) % b.length]!)))) collisions.push(`${building.id} / ${other.id}`);
          }
        }
        for (const key of keys) { const bucket = index.get(key) ?? []; bucket.push(building); index.set(key, bucket); }
      }
      expect(collisions.slice(0, 10)).toEqual([]);
    });

    for (const seed of ['minase-2026', 'trpg-42']) {
      it(`${preset.id} / ${seed}: footprints avoid water, streets, forest and railway rights of way`, () => {
        const map = fixture({ ...DEFAULT_CONFIG, type: preset.id, era: 'railway', terrain: preset.id === 'port' ? 'coast' : 'river', seed });
        const obstacles = map.areas.filter(a => ['water', 'forest', 'park'].includes(a.kind)).map(a => ({ polygon: a.polygon, holes: a.holes, ...bounds(a.polygon) }));
        const segments = [...map.roads, ...map.railways.map(r => ({ ...r, width: 15 }))].flatMap(r => r.points.slice(1).map((b, i) => ({ a: r.points[i]!, b, radius: r.width / 2, ...bounds([r.points[i]!, b]) })));
        const failures: string[] = [];
        for (const building of map.buildings) {
          const p = building.polygon, bb = bounds(p);
          if (bb.x0 < 0 || bb.y0 < 0 || bb.x1 > map.width || bb.y1 > map.height) failures.push(`${building.id}: map bounds`);
          for (const obstacle of obstacles) {
            // Castle keeps and gates stand inside their own reserved bailey land.
            if (building.id.startsWith('castle-') && map.areas.some(a => a.id === 'historic-core' && a.polygon === obstacle.polygon)) continue;
            if (bb.x1 < obstacle.x0 || bb.x0 > obstacle.x1 || bb.y1 < obstacle.y0 || bb.y0 > obstacle.y1) continue;
            if (overlapsRegion(p, obstacle)) failures.push(`${building.id}: ${obstacle.polygon.length}-point land exclusion`);
          }
          for (const s of segments) {
            if (bb.x1 < s.x0 - s.radius || bb.x0 > s.x1 + s.radius || bb.y1 < s.y0 - s.radius || bb.y0 > s.y1 + s.radius) continue;
            if (contains(p, s.a) || contains(p, s.b) || p.some((a, i) => segmentCross(a, p[(i + 1) % p.length]!, s.a, s.b) || pointLineDistance(a, s.a, s.b) < s.radius || pointLineDistance(s.a, a, p[(i + 1) % p.length]!) < s.radius || pointLineDistance(s.b, a, p[(i + 1) % p.length]!) < s.radius)) failures.push(`${building.id}: transport corridor`);
          }
        }
        expect(failures.slice(0, 12)).toEqual([]);
        expect(map.buildings.length).toBeGreaterThan(0);
        expect(map.facilities.every(f => DEFAULT_CONFIG.facilities.includes(f.kind))).toBe(true);
      });
    }
  });
}
