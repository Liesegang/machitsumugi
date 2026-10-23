export interface Point { x: number; y: number }
export interface TerrainSurface { columns: number; rows: number; cellSize: number; elevations: number[] }
export interface TerrainSimulation { resolution: number; steps: number; elapsedYears: number; bedrockErodedVolume: number; storedSedimentVolume: number; exportedSedimentVolume: number; sedimentBalanceError: number; groundBalanceError: number; localExcavationVolume: number; localDepositionVolume: number; localExportedVolume: number; localBalanceError: number }
export type CityType = 'castle' | 'temple' | 'port' | 'newtown' | 'post' | 'onsen';
export type Terrain = 'river' | 'plain' | 'coast';
export type FacilityKind = 'shrine' | 'school' | 'hospital' | 'police' | 'shop' | 'park' | 'castle' | 'port' | 'onsen';
export interface CityConfig {
  name: string; seed: string; type: CityType; terrain: Terrain; density: number; forest: number;
  railway: boolean; stations: number; arterial: boolean; facilities: FacilityKind[];
  era?: 'historic' | 'railway' | 'present';
  targetYear?: number;
  settlement?: 'village' | 'rural-town' | 'regional-city' | 'metropolis';
  populationTrend?: 'declining' | 'stable' | 'growing';
  coastType?: 'bay' | 'ria' | 'delta';
  relief?: 'lowland' | 'hills' | 'mountains';
  mapSize?: 'small' | 'medium' | 'large';
  expressway?: boolean;
  bypass?: boolean;
}
export interface Building { id: string; polygon: Point[]; kind: 'residential' | 'commercial' | 'public' | 'industrial'; height: number; parcelId?: string; builtYear?: number; occupancy?: 'occupied' | 'vacant' | 'underused'; occupiedHouseholds?: number; use?: 'lodging'; lodgingType?: 'ryokan' | 'hotel'; guestRooms?: number; name?: string }
export interface Road { id: string; points: Point[]; kind: 'arterial' | 'local'; width: number; builtYear?: number; role?: 'highway' | 'collector' | 'lane' | 'access' | 'bridge' | 'farm' | 'expressway' | 'ramp'; reason?: string; bridge?: boolean; level?: number; controlledAccess?: boolean; boundaryContinuation?: boolean }
export interface Area { id: string; polygon: Point[]; holes?: Point[][]; kind: 'water' | 'forest' | 'park' | 'field'; name?: string; waterLevel?: number; landUse?: 'farmland' | 'paddy' | 'dry-field' | 'meadow' | 'wetland' | 'vacant' }
export interface Railway { id: string; points: Point[]; name: string; elevations?: number[]; structures?: { kind: 'bridge' | 'cutting' | 'embankment'; from: Point; to: Point; maxHeight: number; length?: number }[]; junction?: { parentId: string; point: Point }; builtYear?: number }
export interface Station { id: string; point: Point; name: string }
export interface Facility { id: string; point: Point; name: string; kind: FacilityKind }
export interface District { id: string; point: Point; name: string; kind?: 'town' | 'ward'; parentId?: string; regions?: { polygon: Point[]; holes?: Point[][] }[]; foundedYear?: number; nameOrigin?: string; namingSource?: 'provisional' | 'llm' | 'edited' }
export interface Parcel { id: string; polygon: Point[]; entrance: Point; access?: Point[]; roadId: string; createdYear: number; developedYear?: number; retiredYear?: number; use: 'residential' | 'commercial' | 'industrial' }
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
  terrainSurface?: TerrainSurface;
  terrainSimulation?: TerrainSimulation;
  unplacedFacilities?: { kind: FacilityKind; reason: string }[];
  /** Transient worker frames are never stored as a completed project. */
  previewPhase?: 'landscape' | 'erosion' | 'hydrology' | 'railway' | 'roads' | 'development';
  previewCrop?: Point[];
  previewSeaLevel?: number;
  regionalContext?: { surface: TerrainSurface; crop: Point[]; extent: number };
}
