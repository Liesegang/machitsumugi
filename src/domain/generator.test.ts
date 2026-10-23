import { describe, expect, it } from 'vitest';
import { CITY_PRESETS, DEFAULT_CONFIG, generateCity } from './generator';
import type { Building, FacilityKind, Point } from './types';

// These geometric predicates are deliberately independent of the generator's rejection code.
const bounds = (p: Point[]) => ({ x0: Math.min(...p.map(q => q.x)), x1: Math.max(...p.map(q => q.x)), y0: Math.min(...p.map(q => q.y)), y1: Math.max(...p.map(q => q.y)) });
function contains(poly: Point[], p: Point) {
  let winding = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y && b.y > p.y && side > 0) winding++;
    if (a.y > p.y && b.y <= p.y && side < 0) winding--;
  }
  return winding !== 0;
}
function segmentCross(a: Point, b: Point, c: Point, d: Point) {
  const orientation = (a: Point, b: Point, c: Point) => (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  return orientation(a, b, c) * orientation(a, b, d) < 0 && orientation(c, d, a) * orientation(c, d, b) < 0;
}
function pointLineDistance(p: Point, a: Point, b: Point) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t);
}

const fixtures = new Map<string, ReturnType<typeof generateCity>>();
function fixture(config: Parameters<typeof generateCity>[0]) {
  const key = JSON.stringify(config);
  if (!fixtures.has(key)) fixtures.set(key, generateCity(config));
  return fixtures.get(key)!;
}

// Integration cases run complete coupled landscapes and historical cities;
// reproducibility and multi-seed harbor cases intentionally build several.
describe('Japanese city generation', { timeout: 1_200_000 }, () => {
  it('is exactly reproducible and gives another layout for another seed', () => {
    const a = generateCity(DEFAULT_CONFIG), b = generateCity({ ...DEFAULT_CONFIG });
    fixtures.set(JSON.stringify(DEFAULT_CONFIG), a);
    expect(a).toEqual(b);
    expect(generateCity({ ...DEFAULT_CONFIG, seed: 'another-city' }).buildings).not.toEqual(a.buildings);
    expect(a.buildings.length).toBeGreaterThan(0);
    expect(a.generatorVersion).toBe('2.1.0');
  });

  it('housing demand changes supply and expansion instead of stamping density over a fixed grid', () => {
    const sparse = fixture({ ...DEFAULT_CONFIG, era: 'railway', density: 0 });
    const dense = fixture({ ...DEFAULT_CONFIG, era: 'railway', density: 100 });
    expect(dense.buildings.length).toBeGreaterThan(sparse.buildings.length);
    expect(dense.roads).not.toEqual(sparse.roads);
    expect(dense.snapshots!.at(-1)!.households).toBeGreaterThan(sparse.snapshots!.at(-1)!.households);
  });

  it('removes both railways and stations when railway is disabled', () => {
    const map = fixture({ ...DEFAULT_CONFIG, railway: false });
    expect(map.railways).toEqual([]);
    expect(map.stations).toEqual([]);
  });

  it('puts requested stations exactly on a continuous line and connects them to streets', () => {
    const map = fixture({ ...DEFAULT_CONFIG, era: 'railway', stations: 5 });
    expect(map.stations).toHaveLength(5);
    for (const station of map.stations) {
      const distances = map.railways.flatMap(r => r.points.slice(1).map((p, i) => pointLineDistance(station.point, r.points[i]!, p)));
      expect(Math.min(...distances)).toBeLessThan(1e-7);
      expect(map.roads.some(r => r.points.some(p => Math.hypot(p.x - station.point.x, p.y - station.point.y) < 1e-7))).toBe(true);
    }
  }, 600000);

  it('normalizes a plain port to a coast without mutating the supplied configuration', () => {
    const input = { ...DEFAULT_CONFIG, density: 0, type: 'port' as const, terrain: 'plain' as const };
    const map = fixture(input);
    expect(input.terrain).toBe('plain');
    expect(map.config.terrain).toBe('coast');
    expect(map).toEqual(fixture({ ...input, terrain: 'coast' }));
  });

  it('puts selected harbors beside the generated shoreline or riverbank', () => {
    for (const terrain of ['coast', 'river'] as const) for (const seed of ['minato-2026', 'trpg-42', 'shoreline-test']) {
      const map = fixture({ ...DEFAULT_CONFIG, type: 'port', density: 0, terrain, seed, facilities: ['port'] });
      const harbor = map.facilities.find(f => f.kind === 'port');
      expect(harbor).toBeDefined();
      const bankDistances = map.areas.filter(a => a.kind === 'water').flatMap(a => a.polygon.map((p, i, polygon) => pointLineDistance(harbor!.point, p, polygon[(i + 1) % polygon.length]!)));
      expect(Math.min(...bankDistances)).toBeGreaterThan(30);
      expect(Math.min(...bankDistances)).toBeLessThan(190);
    }
  });

  it('keeps the founding city independent of future railway events', () => {
    const config = { ...DEFAULT_CONFIG, era: 'historic' as const };
    const noRail = fixture({ ...config, railway: false, stations: 1 });
    const futureRail = fixture({ ...config, railway: true, stations: 5 });
    expect(noRail.roads).toEqual(futureRail.roads);
    expect(noRail.buildings).toEqual(futureRail.buildings);
    expect(futureRail.railways).toEqual([]);
    expect(futureRail.events!.every(event => event.year <= 1800)).toBe(true);
  });

  for (const preset of CITY_PRESETS) {
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
  }

  for (const preset of CITY_PRESETS) for (const seed of ['minase-2026', 'trpg-42']) {
    it(`${preset.id} / ${seed}: footprints avoid water, streets, forest and railway rights of way`, () => {
      const map = fixture({ ...DEFAULT_CONFIG, type: preset.id, era: 'railway', terrain: preset.id === 'port' ? 'coast' : 'river', seed });
      const obstacles = map.areas.filter(a => ['water', 'forest', 'park'].includes(a.kind)).map(a => ({ polygon: a.polygon, ...bounds(a.polygon) }));
      const segments = [...map.roads, ...map.railways.map(r => ({ ...r, width: 15 }))].flatMap(r => r.points.slice(1).map((b, i) => ({ a: r.points[i]!, b, radius: r.width / 2, ...bounds([r.points[i]!, b]) })));
      const failures: string[] = [];
      for (const building of map.buildings) {
        const p = building.polygon, bb = bounds(p);
        if (bb.x0 < 0 || bb.y0 < 0 || bb.x1 > map.width || bb.y1 > map.height) failures.push(`${building.id}: map bounds`);
        for (const obstacle of obstacles) {
          // Castle keeps and gates stand inside their own reserved bailey land.
          if (building.id.startsWith('castle-') && map.areas.some(a => a.id === 'historic-core' && a.polygon === obstacle.polygon)) continue;
          if (bb.x1 < obstacle.x0 || bb.x0 > obstacle.x1 || bb.y1 < obstacle.y0 || bb.y0 > obstacle.y1) continue;
          if (p.some(q => contains(obstacle.polygon, q)) || obstacle.polygon.some(q => contains(p, q)) || p.some((a, i) => obstacle.polygon.some((c, j) => segmentCross(a, p[(i + 1) % p.length]!, c, obstacle.polygon[(j + 1) % obstacle.polygon.length]!)))) failures.push(`${building.id}: ${obstacle.polygon.length}-point land exclusion`);
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
