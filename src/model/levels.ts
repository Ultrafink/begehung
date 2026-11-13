import * as THREE from 'three';

export type LevelKind = 'storey' | 'roof' | 'site' | 'unassigned';

export interface LevelDef {
  key: string;
  name: string;
  short: string;
  kind: LevelKind;
  elevation: number; // metres (finished floor / top of slab)
}

/** Category from Revit family/type name (German Revit templates + common English names). */
const CATS: [RegExp, string][] = [
  [/geländemodell|topograph|topo|gelände_/, 'Gelände'],
  [/tree|baum|pflanz|strauch|hecke/, 'Bepflanzung'],
  [/basisdach|dächer|dachfenster|traufe|ortgang|sparren|dachrinne|roof/, 'Dächer'],
  [/geländer|handlauf|holm|railing/, 'Geländer'],
  [/treppe|treppenlauf|podest|stair/, 'Treppen'],
  [/geschossdecke|decke|bodenplatte|floor|slab/, 'Geschossdecken'],
  [/wand|wall/, 'Wände'],
  [/drehflügel|tür|tuer|door|schiebe/, 'Türen'],
  [/^fe[ _]|fenster|window/, 'Fenster'],
  [/stütze|column|kantholz|holzträger|balken|beam|träger/, 'Tragwerk'],
  [/wc|dusche|duschkopf|waschbecken|ausguss|badewanne|stützgriff|bad-halterung|duschsitz|armatur/, 'Sanitär'],
  [/unterschrank|hoher|arbeitsplatte|kochplatte|küche|spüle|washing/, 'Küche & Hauswirtschaft'],
  [/bett|couch|sofa|tisch|stuhl|kommode|schrank|hocker|tv|regal|büro|bed|chair|table/, 'Möbel'],
  [/pipe|rohr|leitung/, 'Installationen'],
  [/müll|container|eimer|pp-symbol|parkplatz|markierung/, 'Außenanlagen'],
  [/allgemeines modell|generic/, 'Allgemeines Modell'],
];

export function categorize(name: string): string {
  const n = name.toLowerCase().replace(/_/g, ' ');
  for (const [re, c] of CATS) if (re.test(n) || re.test(name.toLowerCase())) return c;
  return 'Sonstiges';
}

export interface ElementGeom {
  id: string;
  name: string;
  category: string;
  box: THREE.Box3; // world metres, Y up
  revitLevel?: string;
}

const ROOF_CATS = new Set(['Dächer']);
const SITE_CATS = new Set(['Gelände', 'Bepflanzung', 'Außenanlagen']);
const SLAB_CATS = new Set(['Geschossdecken']);

/**
 * Detects storeys geometrically: clusters the top elevations of large floor slabs
 * (fallback: base elevations of walls), then assigns every element to the highest
 * storey whose elevation lies below the element's base.
 */
export function detectLevels(elements: ElementGeom[]): {
  levels: LevelDef[];
  assignment: Map<string, string>;
  buildingBox: THREE.Box3;
  auto: boolean;
} {
  // 1) building cluster: elements near the median of wall/slab centres
  const core = elements.filter((e) => e.category === 'Wände' || SLAB_CATS.has(e.category));
  const ref = core.length ? core : elements;
  const cx = median(ref.map((e) => (e.box.min.x + e.box.max.x) / 2));
  const cz = median(ref.map((e) => (e.box.min.z + e.box.max.z) / 2));
  const radius = Math.max(
    25,
    percentile(ref.map((e) => Math.hypot((e.box.min.x + e.box.max.x) / 2 - cx, (e.box.min.z + e.box.max.z) / 2 - cz)), 0.9) * 1.6,
  );
  const remote = (e: ElementGeom) => {
    const c = e.box.getCenter(new THREE.Vector3());
    return Math.hypot(c.x - cx, c.z - cz) > radius;
  };
  // footprint of the walls (expanded) – ground-level things reaching far beyond it are site works
  const wallsBox = new THREE.Box3();
  elements.forEach((e) => { if (e.category === 'Wände' && !remote(e)) wallsBox.union(e.box); });
  const groundY = wallsBox.isEmpty() ? -Infinity : wallsBox.min.y;
  if (!wallsBox.isEmpty()) wallsBox.expandByVector(new THREE.Vector3(4, 0, 4));
  const isRemote = (e: ElementGeom) => {
    if (remote(e)) return true;
    if (wallsBox.isEmpty()) return false;
    const outside = e.box.min.x < wallsBox.min.x || e.box.max.x > wallsBox.max.x || e.box.min.z < wallsBox.min.z || e.box.max.z > wallsBox.max.z;
    return outside && e.box.max.y < groundY + 1.5;
  };

  const building = elements.filter((e) => !SITE_CATS.has(e.category) && !isRemote(e));
  const buildingBox = new THREE.Box3();
  building.forEach((e) => buildingBox.union(e.box));
  if (buildingBox.isEmpty()) elements.forEach((e) => buildingBox.union(e.box));

  // 2) candidate elevations from large slabs (area-weighted)
  const cands: { y: number; w: number }[] = [];
  for (const e of building) {
    if (!SLAB_CATS.has(e.category)) continue;
    const s = e.box.getSize(new THREE.Vector3());
    const area = s.x * s.z;
    if (s.y < 0.8 && area > 8) cands.push({ y: e.box.max.y, w: area });
  }
  if (cands.length < 2) {
    for (const e of building) if (e.category === 'Wände') cands.push({ y: e.box.min.y, w: 1 });
  }
  const clusters: { y: number; w: number }[] = [];
  cands.sort((a, b) => a.y - b.y).forEach((c) => {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(c.y - last.y) < 0.8) {
      last.y = (last.y * last.w + c.y * c.w) / (last.w + c.w);
      last.w += c.w;
    } else clusters.push({ ...c });
  });
  const maxW = Math.max(0, ...clusters.map((c) => c.w));
  // only full storeys: slab area at least 60 % of the largest storey slab
  let elev = clusters.filter((c) => c.w >= maxW * 0.6).map((c) => c.y);
  // keep storeys at least 2.2 m apart
  elev = elev.filter((y, i, a) => i === 0 || y - a[i - 1] > 2.2);
  const auto = elev.length > 0;
  if (!elev.length) elev = [buildingBox.min.y];

  const n = elev.length;
  const storeyNames = (i: number): [string, string] => {
    if (i === 0) return ['Erdgeschoss', 'EG'];
    if (n >= 3 && i === n - 1) return ['Dachgeschoss', 'DG'];
    if (n === 2 || n === 3) return ['Obergeschoss', 'OG'];
    return [`${i}. Obergeschoss`, `${i}.OG`];
  };
  const levels: LevelDef[] = elev.map((y, i) => {
    const [name, short] = storeyNames(i);
    return { key: `L${i}`, name, short, kind: 'storey', elevation: y };
  });
  levels.push({ key: 'ROOF', name: 'Dach', short: 'Dach', kind: 'roof', elevation: buildingBox.max.y });
  levels.push({ key: 'SITE', name: 'Außenanlage', short: 'Außen', kind: 'site', elevation: buildingBox.min.y });

  // 3) assignment
  const assignment = new Map<string, string>();
  for (const e of elements) {
    if (SITE_CATS.has(e.category) || isRemote(e)) { assignment.set(e.id, 'SITE'); continue; }
    if (ROOF_CATS.has(e.category)) { assignment.set(e.id, 'ROOF'); continue; }
    const h = e.box.max.y - e.box.min.y;
    const s = e.box.getSize(new THREE.Vector3());
    const flat = h < 0.8 && s.x * s.z > 2;
    const key = SLAB_CATS.has(e.category) || flat ? e.box.max.y - 0.03 : e.box.min.y + Math.min(0.6, 0.3 * h);
    let idx = 0;
    for (let i = 0; i < elev.length; i++) if (key >= elev[i] - 0.05) idx = i;
    // things starting clearly below the lowest storey but inside the building belong to EG
    assignment.set(e.id, levels[idx].key);
  }
  return { levels, assignment, buildingBox, auto };
}

function median(a: number[]) {
  return percentile(a, 0.5);
}
function percentile(a: number[], p: number) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}
