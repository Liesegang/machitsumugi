import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, generateCity } from './generator';

// Keep all three worlds independent: this checks the complete production path.
describe('Japanese city generation', { timeout: 1_200_000 }, () => {
  it('is exactly reproducible and gives another layout for another seed', () => {
    const a = generateCity(DEFAULT_CONFIG), b = generateCity({ ...DEFAULT_CONFIG });
    expect(a).toEqual(b);
    expect(generateCity({ ...DEFAULT_CONFIG, seed: 'another-city' }).buildings).not.toEqual(a.buildings);
    expect(a.buildings.length).toBeGreaterThan(0);
    expect(a.generatorVersion).toBe('2.1.0');
  });
});
