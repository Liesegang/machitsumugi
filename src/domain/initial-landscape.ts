import type { CityConfig } from './types'
/** Inherited low-relief surface plus heterogeneous tectonic rates. Valleys and
 * channels are not carved into this initial condition; they develop during the
 * coupled uplift/incision/sediment iterations. Rates are fictional scenarios. */
export function initialLandscape(input: { columns: number; resolution: number; extent: number; noise(seed: number, x: number, y: number): number; seed: number; coastType: CityConfig['coastType']; relief?: CityConfig['relief'] }) {
  const { columns: n, resolution: step, extent, noise, seed, coastType } = input
  const elevation = new Float32Array(n * n), uplift = new Float32Array(n * n), erodibility = new Float32Array(n * n)
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  const upliftScale = input.relief === 'lowland' ? .4 : input.relief === 'mountains' ? 4 : 1
  // A narrow Japanese island-margin scenario, rather than a universal shelf
  // width. Shoreface, gentle shelf and steeper outer slope are INITIAL geology;
  // uplift, river supply and marine reworking subsequently change this bed.
  // The surveyed 24km region need not reach an abyssal 1,800–4,500m basin.
  const smoothHinge = (distance: number, radius = 300) => distance <= -radius ? 0 : distance >= radius ? distance : (distance + radius) ** 2 / (4 * radius)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = x * step, py = y * step, ny = py / extent
    const wx = px + (noise(seed + 1, px / 6800, py / 6800) - .5) * 5000, wy = py + (noise(seed + 2, px / 6800, py / 6800) - .5) * 5000
    const geology = noise(seed + 7, wx / 5500, wy / 5500), province = noise(seed + 17, wx / 14000, wy / 14000)
    const marginOffset = (noise(seed + 42, px / 14000, 0) - .5) * 700
    const coast = clamp(((coastType === 'ria' ? .86 : coastType === 'delta' ? .74 : .80) + marginOffset / extent - ny) / .16)
    const offshore = py - extent * .65 - marginOffset
    const shelfEnd = extent * (coastType === 'ria' ? .84 : coastType === 'delta' ? .94 : .90) + marginOffset
    const shelfGrade = coastType === 'ria' ? .025 : coastType === 'delta' ? .012 : .016
    const outerGrade = (coastType === 'ria' ? .15 : coastType === 'delta' ? .055 : .08) * (input.relief === 'mountains' ? 1.7 : 1)
    const bathymetry = .025 * smoothHinge(offshore) + (shelfGrade - .025) * smoothHinge(offshore - 600) + (outerGrade - shelfGrade) * smoothHinge(py - shelfEnd)
    const i = y * n + x
    elevation[i] = 45 - ny * 95 - bathymetry + (noise(seed + 99, px / 1700, py / 1700) - .5) * 20 + (noise(seed + 100, px / 450, py / 450) - .5) * 5
    uplift[i] = (.0001 + Math.pow(geology, 2.2) * .0018 + Math.pow(province, 2) * .0006) * coast * upliftScale
    erodibility[i] = .00004 * (.65 + noise(seed + 3, px / 4000, py / 4000) * .7) * (coastType === 'delta' ? 1.25 : 1)
  }
  return { elevation, uplift, erodibility }
}
