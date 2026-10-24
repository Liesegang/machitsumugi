import type { CityConfig } from './types'
import { coastalBedProfile, coastalLandform } from './coastal-landform'
/** Inherited regional relief plus heterogeneous tectonic rates. Valleys and
 * channels are not carved into this initial condition; they develop during the
 * coupled uplift/incision/sediment iterations. Rates are fictional scenarios. */
export function initialLandscape(input: { columns: number; resolution: number; extent: number; noise(seed: number, x: number, y: number): number; seed: number; coastType: CityConfig['coastType']; relief?: CityConfig['relief'] }) {
  const { columns: n, resolution: step, extent, noise, seed, coastType } = input
  const elevation = new Float32Array(n * n), uplift = new Float32Array(n * n), erodibility = new Float32Array(n * n)
  const upliftScale = input.relief === 'lowland' ? .4 : input.relief === 'mountains' ? 4 : 1
  // A narrow Japanese island-margin scenario, rather than a universal shelf
  // width. Shoreface, gentle shelf and steeper outer slope are INITIAL geology;
  // uplift, river supply and marine reworking subsequently change this bed.
  // The surveyed 24km region need not reach an abyssal 1,800–4,500m basin.
  const landform = coastalLandform({ extent, noise, seed, coastType })
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = x * step, py = y * step
    const wx = px + (noise(seed + 1, px / 6800, py / 6800) - .5) * 5000, wy = py + (noise(seed + 2, px / 6800, py / 6800) - .5) * 5000
    const geology = noise(seed + 7, wx / 5500, wy / 5500), province = noise(seed + 17, wx / 14000, wy / 14000)
    const profile = coastalBedProfile(landform.distance({ x: px, y: py }), coastType, input.relief)
    // Broad structural provinces supply oblique divides and saddles within
    // the shared two-dimensional land block, never prescribed river paths.
    // Their relief and the smaller rock texture join the landward shoreface;
    // the submerged shelf retains its continuous receiving-basin profile.
    const inherited = (province * .65 + geology * .35) * (coastType === 'delta' ? 100 : 240) * profile.landWeight
    const i = y * n + x
    elevation[i] = profile.elevation + inherited + (noise(seed + 99, px / 1700, py / 1700) * 20 + noise(seed + 100, px / 450, py / 450) * 5) * profile.detailWeight
    uplift[i] = (.0001 + Math.pow(geology, 2.2) * .0018 + Math.pow(province, 2) * .0006) * profile.upliftWeight * upliftScale
    erodibility[i] = .00004 * (.65 + noise(seed + 3, px / 4000, py / 4000) * .7) * (coastType === 'delta' ? 1.25 : 1)
  }
  return { elevation, uplift, erodibility }
}
