import type { Area, Building, CityConfig, CityMap, CityType, Facility, FacilityKind, Point, Road } from './types';

export const DEFAULT_CONFIG: CityConfig = {
  name: '水杜市', seed: 'minato-2026', type: 'castle', terrain: 'river', density: 65, forest: 30,
  railway: true, stations: 3, arterial: true, facilities: ['castle', 'shrine', 'school', 'hospital', 'police', 'shop', 'park'],
};
export const CITY_PRESETS: { id: CityType; name: string; description: string }[] = [
  { id: 'castle', name: '城下町', description: '城と堀を中心に、旧町割と駅前の街が重なる' },
  { id: 'temple', name: '門前町', description: '山裾の寺社へ伸びる参道と、沿道の商い' },
  { id: 'port', name: '港町', description: '入り江の港と市場、海岸に沿う市街地' },
  { id: 'newtown', name: '新興住宅地', description: '駅を中心に学校と公園が広がる計画住宅地' },
  { id: 'post', name: '宿場町', description: '旧街道に沿う短冊の町割と、周囲の田畑' },
  { id: 'onsen', name: '温泉町', description: '谷あいの川と温泉、曲がりくねる旅館街' },
];

const W = 4000, H = 3000, NX = 34, NY = 26;
type Box = { minX: number; minY: number; maxX: number; maxY: number };
const box = (p: Point[]): Box => ({ minX: Math.min(...p.map(p => p.x)), minY: Math.min(...p.map(p => p.y)), maxX: Math.max(...p.map(p => p.x)), maxY: Math.max(...p.map(p => p.y)) });
const overlaps = (a: Box, b: Box) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
const rect = (x: number, y: number, w: number, h: number): Point[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function inside(p: Point, polygon: Point[]) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function intersects(a: Point, b: Point, c: Point, d: Point) {
  const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
  return ac * ad < 0 && ca * cb < 0;
}
function polygonHit(a: Point[], b: Point[]) {
  if (!overlaps(box(a), box(b))) return false;
  if (a.some(p => inside(p, b)) || b.some(p => inside(p, a))) return true;
  return a.some((p, i) => b.some((q, j) => intersects(p, a[(i + 1) % a.length]!, q, b[(j + 1) % b.length]!)));
}
/** Parameters along AB where a polygon boundary is crossed, including edge endpoints. */
function crossingParameters(a: Point, b: Point, polygon: Point[]) {
  const ts: number[] = [];
  const dx = b.x - a.x, dy = b.y - a.y;
  for (let i = 0; i < polygon.length; i++) {
    const c = polygon[i]!, d = polygon[(i + 1) % polygon.length]!, ex = d.x - c.x, ey = d.y - c.y;
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-9) continue;
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denominator;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denominator;
    if (t > 1e-7 && t < 1 - 1e-7 && u >= 0 && u <= 1) ts.push(t);
  }
  return ts;
}
function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, n = dx * dx + dy * dy;
  const t = n ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / n)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function ellipse(cx: number, cy: number, rx: number, ry: number, phase: number): Point[] {
  return Array.from({ length: 36 }, (_, i) => {
    const a = i / 36 * Math.PI * 2, r = 1 + .07 * Math.sin(a * 3 + phase) + .04 * Math.cos(a * 5 - phase);
    return { x: cx + Math.cos(a) * rx * r, y: cy + Math.sin(a) * ry * r };
  });
}
function along(points: Point[], t: number): Point {
  const lengths = points.slice(1).map((p, i) => dist(p, points[i]!));
  let rest = lengths.reduce((a, b) => a + b, 0) * t;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (rest <= len) { const a = points[i]!, b = points[i + 1]!, f = rest / len; return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }; }
    rest -= len;
  }
  return points.at(-1)!;
}
const facilityNames: Record<FacilityKind, string> = { shrine: '八幡神社', school: '第一小学校', hospital: '市民病院', police: '中央交番', shop: '中央商店街', park: 'ふれあい公園', castle: '城跡公園', port: '港・魚市場', onsen: '共同浴場' };

/** A seeded, metre-based, deliberately simplified model of Japanese urban morphology. */
export function generateCity(input: CityConfig): CityMap {
  const config: CityConfig = { ...input, facilities: [...input.facilities], density: Math.max(0, Math.min(100, input.density)), forest: Math.max(0, Math.min(100, input.forest)), stations: Math.max(1, Math.min(5, Math.round(input.stations))) };
  if (config.type === 'port' && config.terrain === 'plain') config.terrain = 'coast';
  const random = rng(config.seed), phase = random() * Math.PI * 2;
  const center: Point = config.type === 'port' ? { x: 2520, y: 1570 } : config.type === 'temple' ? { x: 1620, y: 750 } : config.type === 'post' ? { x: 1900, y: 1500 } : config.type === 'onsen' ? { x: 1800, y: 1480 } : { x: 1800, y: 1420 };
  const areas: Area[] = [], roads: Road[] = [], facilities: Facility[] = [], buildings: Building[] = [];
  const riverX = (y: number) => 2850 + 175 * Math.sin(y / 610 + phase) + 55 * Math.cos(y / 230 + phase);
  const coastX = (y: number) => 2920 + 100 * Math.sin(y / 650 + phase) - 140 * Math.exp(-(((y - 1600) / 450) ** 2));
  const waterAt = (p: Point) => config.terrain === 'river' ? Math.abs(p.x - riverX(p.y)) < 58 : config.terrain === 'coast' ? p.x > coastX(p.y) : false;
  if (config.terrain === 'river') {
    const left = Array.from({ length: 91 }, (_, i) => ({ x: riverX(i / 90 * H) - 58, y: i / 90 * H }));
    const right = Array.from({ length: 91 }, (_, i) => ({ x: riverX(i / 90 * H) + 58, y: i / 90 * H })).reverse();
    areas.push({ id: 'river', kind: 'water', polygon: [...left, ...right], name: `${config.name.replace(/[市町村]$/, '')}川` });
  } else if (config.terrain === 'coast') {
    areas.push({ id: 'sea', kind: 'water', polygon: [...Array.from({ length: 91 }, (_, i) => ({ x: coastX(i / 90 * H), y: i / 90 * H })), { x: W, y: H }, { x: W, y: 0 }], name: '青凪湾' });
  }

  const warp = (x: number, y: number): Point => {
    const edge = Math.sin(Math.PI * x / W) * Math.sin(Math.PI * y / H);
    let wx = 50 * Math.sin(y / 290 + phase) + 27 * Math.sin(x / 210 + y / 420), wy = 42 * Math.sin(x / 350 + phase) + 22 * Math.cos(y / 210 + x / 450);
    if (config.type === 'newtown') { wx *= .28; wy *= .28; }
    if (config.type === 'onsen') { wx += 95 * Math.sin(y / 530); wy += 70 * Math.sin(x / 630); }
    if (config.type === 'post') wy += 130 * Math.sin(x / 1200 + phase);
    if (config.type === 'temple') wx += (y - 750) * .075;
    if (config.type === 'port') wy += (x - 2000) * .085;
    return { x: x + wx * edge, y: y + wy * edge };
  };
  const coreI = 15, coreJ = config.type === 'temple' ? 6 : 12;
  const hasCore = config.type === 'castle' || config.type === 'temple';
  const streetRandom = rng(`${config.seed}:street-junctions`);
  const jitter = config.type === 'newtown' ? 0 : config.type === 'onsen' ? 32 : config.type === 'port' ? 22 : 26;
  const nodes = Array.from({ length: NY + 1 }, (_, j) => Array.from({ length: NX + 1 }, (_, i) => {
    const p = warp(i * W / NX, j * H / NY);
    const jx = (streetRandom() * 2 - 1) * jitter, jy = (streetRandom() * 2 - 1) * jitter;
    const preserveCore = hasCore && i >= coreI - 1 && i <= coreI + 2 && j >= coreJ - 1 && j <= coreJ + 2;
    return i === 0 || i === NX || j === 0 || j === NY || preserveCore ? p : { x: p.x + jx, y: p.y + jy };
  }));
  const corePoly = [nodes[coreJ - 1]![coreI - 1]!, nodes[coreJ - 1]![coreI + 2]!, nodes[coreJ + 2]![coreI + 2]!, nodes[coreJ + 2]![coreI - 1]!];
  const coreCenter = { x: corePoly.reduce((s, p) => s + p.x, 0) / 4, y: corePoly.reduce((s, p) => s + p.y, 0) / 4 };
  if (hasCore) {
    const originKind = config.type === 'castle' ? 'castle' : 'shrine';
    const originName = config.type === 'castle' ? `${config.name.replace(/[市町村]$/, '')}城跡` : '水明大社';
    const includeOrigin = config.facilities.includes(originKind);
    areas.push({ id: 'historic-core', kind: 'park', polygon: corePoly, name: includeOrigin ? originName : undefined });
    if (includeOrigin) facilities.push({ id: 'origin', kind: originKind, point: coreCenter, name: originName });
    if (config.type === 'castle') {
      const x = coreCenter.x - 118, y = coreCenter.y - 105;
      [rect(x, y, 236, 15), rect(x, y + 195, 236, 15), rect(x, y + 15, 15, 180), rect(x + 221, y + 15, 15, 180)].forEach((polygon, i) => areas.push({ id: `moat-${i}`, kind: 'water', polygon }));
    }
  }

  const localBridgeRoads = new Set<string>();
  const addRoadRun = (points: Point[], kind: Road['kind'], allowBridge = false) => {
    if (points.length < 2) return;
    const id = `road-${roads.length}`;
    roads.push({ id, points, kind, width: kind === 'arterial' ? 17 : config.type === 'post' ? 6 : 7 });
    if (allowBridge) localBridgeRoads.add(id);
  };
  // Shared junction coordinates keep all the street branches connected. River crossings are bridges.
  for (let axis = 0; axis < 2; axis++) {
    const count = axis ? NX : NY, size = axis ? NY : NX;
    for (let n = 0; n <= count; n++) {
      let run: Point[] = [];
      const major = config.arterial && (axis ? n === 8 || n === 22 || (config.type === 'temple' && n === coreI) : n === 13 || n === 21);
      const allowBridge = axis === 0 && n > 0 && n < NY && n % 7 === 0;
      for (let k = 0; k <= size; k++) {
        const i = axis ? n : k, j = axis ? k : n;
        const forbiddenCore = hasCore && i > coreI - 1 && i < coreI + 2 && j > coreJ - 1 && j < coreJ + 2;
        const p = nodes[j]![i]!;
        const offshore = config.terrain === 'coast' && waterAt(p);
        if (forbiddenCore || offshore) { addRoadRun(run, major ? 'arterial' : 'local', allowBridge); run = []; }
        else run.push(p);
      }
      addRoadRun(run, major ? 'arterial' : 'local', allowBridge);
    }
  }

  if (config.forest > 0) {
    const factor = config.forest / 100;
    const forestSpecs = config.type === 'onsen' ? [[430, 550, 400, 560], [560, 2500, 450, 380], [3480, 720, 360, 500]] : [[450, 470, 520, 400], [650, 2660, 530, 320], [3540, 480, 330, 420]];
    forestSpecs.forEach(([x, y, rx, ry], i) => {
      const polygon = ellipse(x!, y!, rx! * (.3 + factor), ry! * (.3 + factor), phase + i);
      if (!polygon.some(waterAt) && !(hasCore && polygonHit(polygon, corePoly))) areas.push({ id: `forest-${i}`, kind: 'forest', polygon, name: i === 0 ? '北山の森' : undefined });
    });
  }

  // Forest edges and riverbanks interrupt small streets. Only the selected crossings become bridges.
  const roadExclusions = areas.filter(a => a.kind === 'forest' || a.kind === 'water').map(a => ({ ...a, bounds: box(a.polygon) }));
  const clippedRoads: Road[] = [];
  for (const road of roads) {
    const exclusions = roadExclusions.filter(a => road.kind !== 'arterial' && (a.kind === 'forest' || !localBridgeRoads.has(road.id)));
    if (!exclusions.length) { clippedRoads.push(road); continue; }
    let run: Point[] = [], part = 0;
    const finish = () => {
      if (run.length > 1 && dist(run[0]!, run.at(-1)!) > 1) clippedRoads.push({ ...road, id: `${road.id}-part-${part++}`, points: run });
      run = [];
    };
    for (let k = 1; k < road.points.length; k++) {
      const a = road.points[k - 1]!, b = road.points[k]!, segmentBox = box([a, b]);
      const nearby = exclusions.filter(e => overlaps(segmentBox, e.bounds));
      const parameters = [...new Set([0, 1, ...nearby.flatMap(e => crossingParameters(a, b, e.polygon))])].sort((x, y) => x - y);
      const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      for (let t = 1; t < parameters.length; t++) {
        const start = at(parameters[t - 1]!), end = at(parameters[t]!), middle = at((parameters[t - 1]! + parameters[t]!) / 2);
        if (nearby.some(e => inside(middle, e.polygon))) { finish(); continue; }
        if (!run.length) run.push(start);
        else if (dist(run.at(-1)!, start) > .01) { finish(); run.push(start); }
        run.push(end);
      }
    }
    finish();
  }
  roads.splice(0, roads.length, ...clippedRoads);

  const railways: CityMap['railways'] = [], stations: CityMap['stations'] = [];
  if (config.railway) {
    const railPoints = Array.from({ length: 45 }, (_, i) => {
      const y = i / 44 * H;
      return { x: 1170 + 140 * Math.sin(y / 1150 + phase * .3) + (config.type === 'newtown' ? 240 : 0), y };
    });
    railways.push({ id: 'railway-main', name: `${config.name.replace(/[市町村]$/, '')}線`, points: railPoints });
    Array.from({ length: config.stations }, (_, i) => {
      const point = along(railPoints, (i + 1) / (config.stations + 1));
      const base = config.name.replace(/[市町村]$/, '');
      const name = i === Math.floor(config.stations / 2) ? `${base}駅` : `${i < config.stations / 2 ? '北' : '南'}${base}${config.stations > 3 && i !== 0 && i !== config.stations - 1 ? '本町' : ''}駅`;
      stations.push({ id: `station-${i}`, point, name });
      let nearest: Point = nodes[0]![0]!;
      for (const row of nodes) for (const p of row) if (dist(point, p) < dist(point, nearest)) nearest = p;
      roads.push({ id: `station-access-${i}`, kind: 'local', width: 10, points: [point, nearest] });
    });
  }

  const blockedAreas = () => areas.filter(a => a.kind !== 'field').map(a => ({ polygon: a.polygon, bounds: box(a.polygon) }));
  const roadSegments = roads.flatMap(road => road.points.slice(1).map((b, i) => ({ a: road.points[i]!, b, pad: road.width / 2 + 3, bounds: box([road.points[i]!, b]) })));
  const isUsable = (p: Point, pad: number) => {
    const footprint = rect(p.x - pad, p.y - pad, pad * 2, pad * 2), bounds = box(footprint);
    return p.x > 80 && p.x < W - 80 && p.y > 80 && p.y < H - 80
      && !blockedAreas().some(a => overlaps(bounds, a.bounds) && polygonHit(footprint, a.polygon))
      && !roadSegments.some(s => p.x > s.bounds.minX - pad - s.pad && p.x < s.bounds.maxX + pad + s.pad && p.y > s.bounds.minY - pad - s.pad && p.y < s.bounds.maxY + pad + s.pad && segmentDistance(p, s.a, s.b) < pad + s.pad)
      && !railways.some(r => r.points.slice(1).some((q, i) => segmentDistance(p, r.points[i]!, q) < pad + 16));
  };
  const kinds = [...new Set(config.facilities)].filter(kind => !facilities.some(f => f.kind === kind));
  const candidates: Point[] = [];
  for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
    const a = nodes[j]![i]!, b = nodes[j + 1]![i + 1]!;
    candidates.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  const usableCandidates = candidates.filter(p => isUsable(p, 30));
  for (const [index, kind] of kinds.entries()) {
    const harborX = config.terrain === 'coast' ? coastX(1650) - 70 : config.terrain === 'river' ? riverX(1650) - 110 : 2660;
    const target = kind === 'port' ? { x: harborX, y: 1650 } : { x: center.x + Math.cos(index * 2.4) * 650, y: center.y + Math.sin(index * 2.4) * 650 };
    const candidate = usableCandidates.filter(p => {
      if (facilities.some(f => dist(f.point, p) <= 170)) return false;
      if (kind !== 'port' || config.terrain === 'plain') return true;
      const bankDistance = config.terrain === 'coast' ? coastX(p.y) - p.x : Math.abs(p.x - riverX(p.y)) - 58;
      return bankDistance >= 35 && bankDistance <= 180;
    }).sort((a, b) => dist(a, target) - dist(b, target))[0];
    if (!candidate) continue;
    const name = kind === 'school' ? `${config.name.replace(/[市町村]$/, '')}第一小学校` : facilityNames[kind];
    facilities.push({ id: `facility-${kind}`, kind, point: candidate, name });
    areas.push({ id: `facility-lot-${kind}`, kind: kind === 'park' || kind === 'shrine' ? 'park' : 'field', polygon: rect(candidate.x - 35, candidate.y - 34, 70, 68), name: kind === 'park' ? name : undefined });
    if (kind === 'park' || kind === 'shrine') continue;
    buildings.push({ id: `facility-building-${kind}`, polygon: rect(candidate.x - 23, candidate.y - 18, 46, 36), kind: kind === 'shop' ? 'commercial' : kind === 'port' ? 'industrial' : 'public', height: 2 });
  }

  // A spatial index keeps thousands of footprint-versus-road checks inexpensive.
  const bucketSize = 110;
  type Segment = { a: Point; b: Point; pad: number; bounds: Box };
  const buckets = new Map<string, Segment[]>();
  const insert = (s: Segment) => {
    for (let x = Math.floor(s.bounds.minX / bucketSize); x <= Math.floor(s.bounds.maxX / bucketSize); x++) for (let y = Math.floor(s.bounds.minY / bucketSize); y <= Math.floor(s.bounds.maxY / bucketSize); y++) {
      const key = `${x},${y}`, arr = buckets.get(key) ?? []; arr.push(s); buckets.set(key, arr);
    }
  };
  for (const road of [...roads, ...railways.map(r => ({ ...r, width: 15 }))]) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, pad = road.width / 2 + 3;
      insert({ a, b, pad, bounds: { minX: Math.min(a.x, b.x) - pad, minY: Math.min(a.y, b.y) - pad, maxX: Math.max(a.x, b.x) + pad, maxY: Math.max(a.y, b.y) + pad } });
    }
  }
  const obstacles = blockedAreas();
  const reserve = facilities.map(f => box(rect(f.point.x - 40, f.point.y - 40, 80, 80)));
  const footprints = new Map<string, Building[]>();
  const indexBuilding = (building: Building) => {
    const bounds = box(building.polygon);
    for (let x = Math.floor(bounds.minX / bucketSize); x <= Math.floor(bounds.maxX / bucketSize); x++) for (let y = Math.floor(bounds.minY / bucketSize); y <= Math.floor(bounds.maxY / bucketSize); y++) {
      const key = `${x},${y}`, bucket = footprints.get(key) ?? [];
      bucket.push(building); footprints.set(key, bucket);
    }
  };
  buildings.forEach(indexBuilding);
  const canBuild = (polygon: Point[]) => {
    const bounds = box(polygon);
    if (bounds.minX < 15 || bounds.maxX > W - 15 || bounds.minY < 15 || bounds.maxY > H - 15 || reserve.some(b => overlaps(bounds, b))) return false;
    if (obstacles.some(a => overlaps(bounds, a.bounds) && polygonHit(polygon, a.polygon))) return false;
    const checked = new Set<Segment>();
    const checkedBuildings = new Set<Building>();
    for (let x = Math.floor(bounds.minX / bucketSize); x <= Math.floor(bounds.maxX / bucketSize); x++) for (let y = Math.floor(bounds.minY / bucketSize); y <= Math.floor(bounds.maxY / bucketSize); y++) {
      for (const building of footprints.get(`${x},${y}`) ?? []) {
        if (checkedBuildings.has(building)) continue;
        checkedBuildings.add(building);
        if (polygonHit(polygon, building.polygon)) return false;
      }
      for (const s of buckets.get(`${x},${y}`) ?? []) {
        if (checked.has(s) || !overlaps(bounds, s.bounds)) continue;
        checked.add(s);
        if (inside(s.a, polygon) || inside(s.b, polygon) || polygon.some((p, i) => intersects(p, polygon[(i + 1) % polygon.length]!, s.a, s.b) || segmentDistance(p, s.a, s.b) < s.pad || segmentDistance(s.a, p, polygon[(i + 1) % polygon.length]!) < s.pad || segmentDistance(s.b, p, polygon[(i + 1) % polygon.length]!) < s.pad)) return false;
      }
    }
    return true;
  };
  // Each cell is an actual street block; small plots share access from the enclosing streets.
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    if (hasCore && i >= coreI - 1 && i < coreI + 2 && j >= coreJ - 1 && j < coreJ + 2) continue;
    const a = nodes[j]![i]!, b = nodes[j]![i + 1]!, c = nodes[j + 1]![i]!, d = nodes[j + 1]![i + 1]!;
    const blockCenter = { x: (a.x + d.x) / 2, y: (a.y + d.y) / 2 };
    const centerDistance = dist(blockCenter, center), stationDistance = stations.length ? Math.min(...stations.map(s => dist(s.point, blockCenter))) : Infinity;
    let urban = Math.max(.1, 1 - centerDistance / 2350);
    if (config.type === 'post') urban *= .35 + .65 * Math.exp(-(((blockCenter.y - 1500) / 480) ** 2));
    if (config.type === 'onsen') urban *= .35 + .65 * Math.exp(-(((blockCenter.x - 1850) / 550) ** 2));
    if (config.type === 'temple') urban *= .5 + .5 * Math.exp(-(((blockCenter.x - 1750) / 650) ** 2));
    if (config.type === 'newtown') urban = Math.max(urban, 1 - stationDistance / 1250);
    const chance = (.38 + config.density / 100 * .66) * (.45 + urban * .55);
    const farm = centerDistance > 1600 && random() > .50 && config.type !== 'port';
    if (farm && !waterAt(blockCenter) && !obstacles.some(o => inside(blockCenter, o.polygon))) {
      const inset = [a, b, d, c].map(p => ({ x: blockCenter.x + (p.x - blockCenter.x) * .73, y: blockCenter.y + (p.y - blockCenter.y) * .73 }));
      if (!inset.some(waterAt)) areas.push({ id: `field-${i}-${j}`, kind: 'field', polygon: inset });
      continue;
    }
    const count = config.type === 'post' ? 7 : 6;
    for (let row = 0; row < 6; row++) for (let col = 0; col < count; col++) {
      const keep = random(), f = (col + .5) / count, g = (row + .5) / 6;
      const px = a.x * (1 - f) * (1 - g) + b.x * f * (1 - g) + c.x * (1 - f) * g + d.x * f * g;
      const py = a.y * (1 - f) * (1 - g) + b.y * f * (1 - g) + c.y * (1 - f) * g + d.y * f * g;
      const w = config.type === 'post' ? 9 + random() * 3 : 10 + random() * 7, h = 11 + random() * 7;
      const angle = Math.atan2(b.y - a.y, b.x - a.x), co = Math.cos(angle), si = Math.sin(angle);
      const polygon = rect(-w / 2, -h / 2, w, h).map(p => ({ x: Math.round((px + p.x * co - p.y * si) * 10) / 10, y: Math.round((py + p.x * si + p.y * co) * 10) / 10 }));
      const mix = random(), tall = random();
      if (keep > chance || !canBuild(polygon)) continue;
      const commercial = (stationDistance < 340 || centerDistance < 380 || (config.type === 'post' && Math.abs(py - 1500) < 160)) && mix < .68;
      const industrial = config.type === 'port' && px > 2330 && mix > .45;
      const building: Building = { id: `building-${i}-${j}-${row}-${col}`, polygon, kind: industrial ? 'industrial' : commercial ? 'commercial' : 'residential', height: commercial ? 2 + Math.floor(tall * 5) : 1 + Math.floor(tall * 3) };
      buildings.push(building); indexBuilding(building);
    }
  }
  const suffixes = ['本町', '桜町', '緑町', '東町', '西町', '南町', '北町', '新町'];
  const districts: CityMap['districts'] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) {
    const point = { x: 500 + i * 880 + (random() - .5) * 140, y: 550 + j * 960 + (random() - .5) * 100 };
    if (!waterAt(point)) districts.push({ id: `district-${i}-${j}`, point, name: `${suffixes[(i + j * 3) % suffixes.length]}${j + 1}丁目` });
  }
  return { width: W, height: H, config, buildings, roads, areas, railways, stations, facilities, districts, description: CITY_PRESETS.find(p => p.id === config.type)!.description };
}
