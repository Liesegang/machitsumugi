import type { Building, CityMap, Point, Road } from '../domain/types'
import { distance, distanceToSegment, pointInRegion } from '../domain/geometry'
import type { MapFeature } from './inspect'
import type { EditableEntityKind } from '../domain/map-edits'

export type EditorTool = 'select' | 'building' | 'road' | 'area'
export type EditorCover = 'forest' | 'woodland' | 'park' | 'meadow' | 'paddy' | 'dry-field'
export interface EditorValues {
  name: string; buildingKind: Building['kind']; floors: number
  roadKind: Road['kind']; width: number; bridge: boolean; cover: EditorCover
}
export type EditorSelection = MapFeature | { type: 'station'; item: CityMap['stations'][number] }
export const DEFAULT_EDITOR_VALUES: EditorValues = { name: '', buildingKind: 'residential', floors: 2, roadKind: 'local', width: 6, bridge: false, cover: 'meadow' }

export function findEditorTarget(map: CityMap, point: Point, kind: EditableEntityKind): EditorSelection | null {
  if (kind === 'building') { const item = [...map.buildings].reverse().find(b => pointInRegion(point, b)); return item ? { type: kind, item } : null }
  if (kind === 'area') { const item = [...map.areas].reverse().find(a => pointInRegion(point, a)); return item ? { type: kind, item } : null }
  if (kind === 'road' || kind === 'railway') {
    const routes = kind === 'road' ? map.roads : map.railways
    const candidates = routes.map(item => ({ item, distance: Math.min(...item.points.slice(1).map((b, i) => distanceToSegment(point, item.points[i]!, b))) })).sort((a, b) => a.distance - b.distance)
    const item = candidates[0]?.distance !== undefined && candidates[0].distance < 25 ? candidates[0].item : undefined
    return item ? { type: kind, item } as MapFeature : null
  }
  if (kind === 'district') {
    const item = map.districts.find(d => d.regions?.some(region => pointInRegion(point, region))) ?? map.districts.find(d => distance(d.point, point) < 80)
    return item ? { type: kind, item } : null
  }
  const items = kind === 'station' ? map.stations : map.facilities
  const item = [...items].sort((a, b) => distance(a.point, point) - distance(b.point, point))[0]
  return item && distance(item.point, point) < 100 ? { type: kind, item } as EditorSelection : null
}
