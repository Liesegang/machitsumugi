import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './generator';
import { fixture } from './test-support/generator-fixture';
import { pointLineDistance } from './test-support/map-geometry';

describe('Japanese city generation', { timeout: 1_200_000 }, () => {
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
});
