export interface Point { x: number; y: number }
export type CityType = 'castle' | 'temple' | 'port' | 'newtown' | 'post' | 'onsen';
export type Terrain = 'river' | 'plain' | 'coast';
export type FacilityKind = 'shrine' | 'school' | 'hospital' | 'police' | 'shop' | 'park' | 'castle' | 'port' | 'onsen';
export interface CityConfig {
  name: string; seed: string; type: CityType; terrain: Terrain; density: number; forest: number;
  railway: boolean; stations: number; arterial: boolean; facilities: FacilityKind[];
  era?: 'historic' | 'railway' | 'present';
}
export interface Building { id: string; polygon: Point[]; kind: 'residential' | 'commercial' | 'public' | 'industrial'; height: number; parcelId?: string; builtYear?: number }
export interface Road { id: string; points: Point[]; kind: 'arterial' | 'local'; width: number; builtYear?: number; role?: 'highway' | 'collector' | 'lane' | 'access' | 'bridge' | 'farm'; reason?: string; bridge?: boolean }
export interface Area { id: string; polygon: Point[]; kind: 'water' | 'forest' | 'park' | 'field'; name?: string }
export interface Railway { id: string; points: Point[]; name: string; elevations?: number[]; structures?: { kind: 'bridge' | 'cutting' | 'embankment'; from: Point; to: Point; maxHeight: number }[] }
export interface Station { id: string; point: Point; name: string }
export interface Facility { id: string; point: Point; name: string; kind: FacilityKind }
export interface District { id: string; point: Point; name: string }
export interface Parcel { id: string; polygon: Point[]; entrance: Point; roadId: string; createdYear: number; developedYear?: number; use: 'residential' | 'commercial' | 'industrial' }
export interface GrowthEvent { id: string; year: number; kind: 'road' | 'construction' | 'acquisition' | 'railway'; entityId: string; reason: string }
export interface SimulationSnapshot { year: number; households: number; capacity: number; vacant: number; unmet: number; roads: number; buildings: number }
export interface CityMap {
  width: number; height: number; config: CityConfig; buildings: Building[]; roads: Road[]; areas: Area[];
  railways: Railway[]; stations: Station[]; facilities: Facility[]; districts: District[]; description: string;
  growthLog?: { phase: string; roadsAdded: number; year?: number; reason?: string }[];
  generatorVersion?: string;
  year?: number;
  parcels?: Parcel[];
  events?: GrowthEvent[];
  snapshots?: SimulationSnapshot[];
  blocks?: { id: string; polygon: Point[] }[];
}
