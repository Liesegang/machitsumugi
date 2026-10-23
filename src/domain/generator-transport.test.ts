import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './generator';
import { fixture } from './test-support/generator-fixture';
import { pointLineDistance } from './test-support/map-geometry';

describe('Japanese city generation', { timeout: 1_200_000 }, () => {
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
});
