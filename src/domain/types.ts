export interface Point { x: number; y: number }
export interface TerrainSurface { columns: number; rows: number; cellSize: number; elevations: number[] }
export interface TerrainSimulation { resolution: number; steps: number; elapsedYears: number; bedrockErodedVolume: number; storedSedimentVolume: number; exportedSedimentVolume: number; sedimentBalanceError: number; groundBalanceError: number; localExcavationVolume: number; localDepositionVolume: number; localExportedVolume: number; localBalanceError: number }
export type CityType = 'castle' | 'temple' | 'port' | 'newtown' | 'post' | 'onsen';
export type Terrain = 'river' | 'plain' | 'coast';
export type FacilityKind = 'shrine' | 'school' | 'university' | 'hospital' | 'police' | 'shop' | 'park' | 'castle' | 'port' | 'onsen';
export interface CityConfig {
  /** Missing on older projects: their history engine and saved geometry stay intact. */
  cityEngine?: 'history' | 'layout' | 'continuous';
  name: string; seed: string; type: CityType; terrain: Terrain; density: number; forest: number;
  railway: boolean; stations: number; arterial: boolean; facilities: FacilityKind[];
  era?: 'historic' | 'railway' | 'present';
  targetYear?: number;
  settlement?: 'village' | 'rural-town' | 'regional-city' | 'metropolis';
  populationTrend?: 'declining' | 'stable' | 'growing';
  coastType?: 'bay' | 'ria' | 'delta' | 'peninsula';
  relief?: 'lowland' | 'hills' | 'mountains';
  mapSize?: 'small' | 'medium' | 'large';
  expressway?: boolean;
  bypass?: boolean;
  subway?: boolean;
}
export interface Building { id: string; polygon: Point[]; kind: 'residential' | 'commercial' | 'public' | 'industrial'; height: number; parcelId?: string; builtYear?: number; occupancy?: 'occupied' | 'vacant' | 'underused'; occupiedHouseholds?: number; use?: 'lodging'; lodgingType?: 'ryokan' | 'hotel'; guestRooms?: number; name?: string }
export interface Road { id: string; points: Point[]; kind: 'arterial' | 'local'; width: number; builtYear?: number; modifiedYear?: number; role?: 'highway' | 'collector' | 'lane' | 'access' | 'bridge' | 'farm' | 'expressway' | 'ramp'; reason?: string; bridge?: boolean; level?: number; controlledAccess?: boolean; boundaryContinuation?: boolean; /** Independently surveyed regional alignment; local streets cannot inherit it by routing. */ throughRouteId?: string; surveyedBridgeSpans?: { bankA: Point; bankB: Point; riverId?: string; candidateId?: string }[] }
export interface Area { id: string; polygon: Point[]; holes?: Point[][]; kind: 'water' | 'forest' | 'park' | 'field'; name?: string; waterLevel?: number; landUse?: 'farmland' | 'paddy' | 'dry-field' | 'meadow' | 'woodland' | 'wetland' | 'vacant' }
export interface Railway { id: string; points: Point[]; name: string; mode?: 'surface' | 'subway'; elevations?: number[]; structures?: { kind: 'bridge' | 'cutting' | 'embankment'; from: Point; to: Point; maxHeight: number; length?: number }[]; junction?: { parentId: string; point: Point }; builtYear?: number }
export interface Station { id: string; point: Point; name: string; railwayId?: string; builtYear?: number; mode?: 'surface' | 'subway'; entrance?: Point; buildingPolygon?: Point[] }
export interface Facility { id: string; point: Point; name: string; kind: FacilityKind }
export interface District { id: string; point: Point; name: string; kind?: 'town' | 'ward'; parentId?: string; regions?: { polygon: Point[]; holes?: Point[][] }[]; foundedYear?: number; nameOrigin?: string; namingSource?: 'provisional' | 'llm' | 'edited' }
export interface Parcel { id: string; polygon: Point[]; entrance: Point; access?: Point[]; roadId: string; createdYear: number; developedYear?: number; retiredYear?: number; use: 'residential' | 'commercial' | 'industrial' }
export interface GrowthEvent { id: string; year: number; kind: 'road' | 'construction' | 'demolition' | 'acquisition' | 'railway'; entityId: string; reason: string }
export interface SimulationSnapshot { year: number; households: number; capacity: number; vacant: number; unmet: number; roads: number; buildings: number }
/** Actual versions are valid on [from,to); geometry is stored only when it changes. */
export interface TimelineVersion<T> { from: number; to?: number; value: T }
export interface BuildingState { id: string; from: number; occupancy?: Building['occupancy']; occupiedHouseholds?: number }
export interface CityTimeline {
  version: 1; fromYear: number; throughYear: number
  roads: TimelineVersion<Road>[]; buildings: TimelineVersion<Building>[]; areas: TimelineVersion<Area>[]
  railways: TimelineVersion<Railway>[]; stations: TimelineVersion<Station>[]; facilities: TimelineVersion<Facility>[]
  districts: TimelineVersion<District>[]; parcels: TimelineVersion<Parcel>[]
  buildingStates: BuildingState[]; terrainSurfaces: TimelineVersion<TerrainSurface>[]
  events?: GrowthEvent[]; snapshots?: SimulationSnapshot[]; growthLog?: CityMap['growthLog']
}
export interface CityMap {
  width: number; height: number; config: CityConfig; buildings: Building[]; roads: Road[]; areas: Area[];
  railways: Railway[]; stations: Station[]; facilities: Facility[]; districts: District[]; description: string;
  growthLog?: { phase: string; roadsAdded: number; year?: number; reason?: string; households?: number; unmetHouseholds?: number; constructionCost?: number }[];
  generatorVersion?: string;
  year?: number;
  timeline?: CityTimeline;
  parcels?: Parcel[];
  events?: GrowthEvent[];
  snapshots?: SimulationSnapshot[];
  blocks?: { id: string; polygon: Point[] }[];
  terrainSurface?: TerrainSurface;
  terrainSimulation?: TerrainSimulation;
  unplacedFacilities?: { kind: FacilityKind; reason: string }[];
  /** Transient worker frames are never stored as a completed project. */
  previewPhase?: 'landscape' | 'erosion' | 'hydrology' | 'railway' | 'roads' | 'development';
  /** Transient acquired grounds for reproducing a road-planning preview.
   * Completed projects contain their dated geometry instead. */
  previewPlanning?: { reservedGrounds: { polygon: Point[]; holes?: Point[][] }[] };
  previewCrop?: Point[];
  previewSeaLevel?: number;
  regionalContext?: { surface: TerrainSurface; crop: Point[]; extent: number };
}
