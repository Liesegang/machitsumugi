import type { Point } from './types'
import type { PolygonRegion } from './geometry'
export const LAYOUT_GENERATOR_VERSION = '2.6.0-layout.14'

/** A whole-city land brief. Actual station catchments are measured on the final
 * public street network; this shape does not grant a building form or a title. */
export interface LayoutFirstZone extends PolygonRegion {
  id: string
  center: Point
  radius: number
  kind: 'historic' | 'station' | 'residential' | 'apartment' | 'industrial' | 'rural'
  builtYear: number
  /** Intended developed fraction in [0,1], after water and protected ground. */
  density: number
  maximumFloors: number
  angle?: number
}
