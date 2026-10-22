export interface Point { x: number; y: number }
export type CityType = 'castle' | 'temple' | 'port' | 'newtown' | 'post' | 'onsen';
export type Terrain = 'river' | 'plain' | 'coast';
export type FacilityKind = 'shrine' | 'school' | 'hospital' | 'police' | 'shop' | 'park' | 'castle' | 'port' | 'onsen';
export interface CityConfig {
  name: string; seed: string; type: CityType; terrain: Terrain; density: number; forest: number;
  railway: boolean; stations: number; arterial: boolean; facilities: FacilityKind[];
}
export interface Building { id: string; polygon: Point[]; kind: 'residential' | 'commercial' | 'public' | 'industrial'; height: number }
export interface Road { id: string; points: Point[]; kind: 'arterial' | 'local'; width: number }
export interface Area { id: string; polygon: Point[]; kind: 'water' | 'forest' | 'park' | 'field'; name?: string }
export interface Railway { id: string; points: Point[]; name: string }
export interface Station { id: string; point: Point; name: string }
export interface Facility { id: string; point: Point; name: string; kind: FacilityKind }
export interface District { id: string; point: Point; name: string }
export interface CityMap {
  width: number; height: number; config: CityConfig; buildings: Building[]; roads: Road[]; areas: Area[];
  railways: Railway[]; stations: Station[]; facilities: Facility[]; districts: District[]; description: string;
}
