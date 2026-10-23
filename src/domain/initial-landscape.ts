import type { CityConfig } from './types'
/** Inherited low-relief surface plus heterogeneous tectonic rates. Valleys and
 * channels are not carved into this initial condition; they develop during the
 * coupled uplift/incision/sediment iterations. Rates are fictional scenarios. */
export function initialLandscape(input: { columns: number; resolution: number; extent: number; noise(seed: number, x: number, y: number): number; seed: number; coastType: CityConfig['coastType']; relief?: CityConfig['relief'] }) {
  const { columns: n, resolution: step, extent, noise, seed, coastType } = input
  const elevation = new Float32Array(n * n), uplift = new Float32Array(n * n), erodibility = new Float32Array(n * n)
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  const upliftScale = input.relief === 'lowland' ? .4 : input.relief === 'mountains' ? 4 : 1
  // A continental margin must retain accommodation for a million years of
  // fluvial sediment. This is the initial seabed, never a post-erosion sea mask.
  // The mountain scenario represents an active margin with a deeper receiving
  // basin, rather than raising mountains over the same shallow enclosed shelf.
  const offshoreDepth = input.relief === 'mountains' ? 4500 : 1800
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = x * step, py = y * step, ny = py / extent
    const wx = px + (noise(seed + 1, px / 6800, py / 6800) - .5) * 5000, wy = py + (noise(seed + 2, px / 6800, py / 6800) - .5) * 5000
    const geology = noise(seed + 7, wx / 5500, wy / 5500), province = noise(seed + 17, wx / 14000, wy / 14000)
    const coast = clamp(((coastType === 'ria' ? .99 : coastType === 'delta' ? .84 : .90) - ny) / .24)
    // Offshore accommodation is an initial geological boundary condition. A
    // uniformly 0–50m deep sea filled entirely with a million years of sediment,
    // leaving a false one-cell coastline at the simulation's open boundary.
    const shelf = clamp((ny - .65) / .35), bathymetry = shelf * shelf * (3 - 2 * shelf) * offshoreDepth
    const i = y * n + x
    elevation[i] = 45 - ny * 95 - bathymetry + (noise(seed + 99, px / 1700, py / 1700) - .5) * 20 + (noise(seed + 100, px / 450, py / 450) - .5) * 5
    uplift[i] = (.0001 + Math.pow(geology, 2.2) * .0018 + Math.pow(province, 2) * .0006) * coast * upliftScale
    erodibility[i] = .00004 * (.65 + noise(seed + 3, px / 4000, py / 4000) * .7) * (coastType === 'delta' ? 1.25 : 1)
  }
  return { elevation, uplift, erodibility }
}
