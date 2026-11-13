import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFbxMeta, type FbxMeta } from '../fbx/fbxMeta';
import { createPbr, resolveMaterial } from './materials';
import { categorize, detectLevels, type LevelDef } from './levels';

export type RenderMode = 'realistic' | 'white' | 'wireframe';

export interface BimElement {
  id: string;
  name: string;
  revitId?: string;
  category: string;
  level: string;
  autoLevel: string;
  meshes: THREE.Mesh[];
  box: THREE.Box3;
  params: Record<string, string>;
  materialNames: string[];
  hidden: boolean;
}

export interface ModelInfo {
  fileName: string;
  fileSize: number;
  format: string;
  application: string;
  upAxis: string;
  unit: string;
  scaleToMeters: number;
  meshCount: number;
  elementCount: number;
  triangles: number;
  materialCount: number;
  levelsAuto: boolean;
  revitMaterialProxies: boolean;
  size: THREE.Vector3;
  notes: string[];
}

const BIG = 1e6;

export class ModelScene {
  root = new THREE.Group();
  groups = new Map<string, THREE.Group>();
  levels: LevelDef[] = [];
  elements = new Map<string, BimElement>();
  materials = new Map<string, THREE.Material>();
  planes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), BIG), new THREE.Plane(new THREE.Vector3(-1, 0, 0), BIG), new THREE.Plane(new THREE.Vector3(0, 0, -1), BIG)];
  buildingBox = new THREE.Box3();
  modelBox = new THREE.Box3();
  info!: ModelInfo;
  mode: RenderMode = 'realistic';
  selected = new Set<string>();
  isolated: Set<string> | null = null;
  explode = 0;

  private white: THREE.MeshStandardMaterial;
  private whiteGlass: THREE.MeshStandardMaterial;
  private wire: THREE.MeshBasicMaterial;
  private highlight: THREE.MeshStandardMaterial;
  private geometries = new Set<THREE.BufferGeometry>();

  constructor() {
    this.root.name = 'Modell';
    const cp = this.planes;
    this.white = new THREE.MeshStandardMaterial({ color: '#f2f1ee', roughness: 0.85, side: THREE.DoubleSide, clippingPlanes: cp });
    this.whiteGlass = new THREE.MeshStandardMaterial({ color: '#dfe9ee', roughness: 0.1, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: cp });
    this.wire = new THREE.MeshBasicMaterial({ color: '#9fb3c8', wireframe: true, clippingPlanes: cp });
    this.highlight = new THREE.MeshStandardMaterial({ color: '#4aa3ff', emissive: '#0d3a6e', roughness: 0.5, side: THREE.DoubleSide, clippingPlanes: cp });
  }

  /* ------------------------------------------------------------------ loading */

  static async load(buf: ArrayBuffer, fileName: string): Promise<ModelScene> {
    const ms = new ModelScene();
    const lower = fileName.toLowerCase();
    let src: THREE.Object3D;
    let meta: FbxMeta | null = null;
    const notes: string[] = [];
    let format = 'FBX';

    if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
      format = lower.endsWith('.glb') ? 'GLB' : 'glTF';
      const gltf = await new GLTFLoader().parseAsync(buf, '');
      src = gltf.scene;
    } else {
      meta = readFbxMeta(buf);
      if (meta.format === 'ascii') format = 'FBX (ASCII)';
      const loader = new FBXLoader();
      src = loader.parse(buf, '');
    }

    // --- orientation + units -> metres, Y up
    const wrapper = new THREE.Group();
    wrapper.add(src);
    let scale = 1;
    let upName = 'Y';
    let unitName = 'm';
    if (meta) {
      scale = meta.unitScaleFactor / 100;
      unitName = meta.unitScaleFactor === 30.48 ? 'Fuß (Revit intern)' : meta.unitScaleFactor === 1 ? 'cm' : meta.unitScaleFactor === 100 ? 'm' : meta.unitScaleFactor === 0.1 ? 'mm' : `${meta.unitScaleFactor} cm`;
      if (meta.upAxis === 2) { wrapper.rotation.x = (-Math.PI / 2) * meta.upAxisSign; upName = 'Z'; }
      else if (meta.upAxis === 0) { wrapper.rotation.z = (Math.PI / 2) * meta.upAxisSign; upName = 'X'; }
      else upName = 'Y';
    }
    wrapper.scale.setScalar(scale);
    wrapper.updateMatrixWorld(true);

    // drop cameras / lights from file
    const strip: THREE.Object3D[] = [];
    src.traverse((o) => { if ((o as THREE.Camera).isCamera || (o as THREE.Light).isLight) strip.push(o); });
    strip.forEach((o) => o.parent?.remove(o));

    // --- element candidates
    //  a) GLB exported by this viewer: meshes carry a3d* tags (glTF extras)
    //  b) otherwise: top-level children of the file root (Revit FBX: one per element),
    //     unwrapping single wrapper groups (typical for GLB/glTF from other tools)
    type Cand = { top: THREE.Object3D; name: string; meshes: THREE.Mesh[]; tag?: { level?: string; category?: string } };
    const cands: Cand[] = [];
    const tagged = new Map<string, Cand>();
    src.traverse((o) => {
      type Tag = { a3dElement?: string; a3dName?: string; a3dLevel?: string; a3dCategory?: string };
      // multi-material meshes come back from glTF as a group of primitives: tag sits on the parent
      const t = ((o.userData as Tag).a3dElement ? o.userData : o.parent?.userData ?? {}) as Tag;
      if (!(o as THREE.Mesh).isMesh || !t.a3dElement) return;
      let c = tagged.get(t.a3dElement);
      if (!c) tagged.set(t.a3dElement, (c = { top: o, name: t.a3dName || o.name, meshes: [], tag: { level: t.a3dLevel, category: t.a3dCategory } }));
      c.meshes.push(o as THREE.Mesh);
    });
    if (tagged.size) cands.push(...tagged.values());
    else {
      let container: THREE.Object3D = src;
      while (container.children.length === 1 && !(container.children[0] as THREE.Mesh).isMesh) container = container.children[0];
      container.children.slice().forEach((top, i) => {
        const meshes: THREE.Mesh[] = [];
        top.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
        if (meshes.length) cands.push({ top, name: (top.userData.originalName as string) || top.name || `Element ${i + 1}`, meshes });
      });
    }
    const elementList: BimElement[] = [];
    const levelHints = new Map<string, string>();
    const matCache = new Map<string, THREE.Material>();
    const getRevitMat = (name: string) => {
      let m = matCache.get(name);
      if (!m) {
        m = createPbr(name, resolveMaterial(name, meta?.assetColors.get(name)));
        matCache.set(name, m);
      }
      return m;
    };
    const convertMat = (m: THREE.Material): THREE.Material => {
      const key = (m.name || 'Material') + '#' + m.uuid.slice(0, 4);
      let out = matCache.get(key);
      if (out) return out;
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) out = m;
      else {
        const pm = m as THREE.MeshPhongMaterial;
        out = new THREE.MeshStandardMaterial({
          name: m.name || 'Material', color: pm.color ?? new THREE.Color('#cccccc'), map: pm.map ?? null,
          transparent: pm.transparent || pm.opacity < 1, opacity: pm.opacity, roughness: 0.7, metalness: 0,
        });
        m.dispose();
      }
      out.side = THREE.DoubleSide;
      out.userData.originalColor = '#' + ((out as THREE.MeshStandardMaterial).color?.getHexString() ?? 'cccccc');
      out.userData.isGlass = (out as THREE.MeshStandardMaterial).opacity < 0.9;
      matCache.set(key, out);
      return out;
    };

    let triangles = 0;
    let meshCount = 0;
    cands.forEach(({ top, name: rawName, meshes, tag }) => {
      const name = rawName.replace(/\s+/g, ' ').trim();
      const revitId = /\[(\d+)\]\s*$/.exec(name)?.[1];
      const matNames = new Set<string>();

      for (const mesh of meshes) {
        meshCount++;
        const g = mesh.geometry;
        this_geomStats(g, (t) => (triangles += t));
        const fbxId = (mesh as unknown as { ID?: number }).ID;
        const names = (fbxId !== undefined && meta?.modelMaterials.get(fbxId)) || null;
        let mats: THREE.Material | THREE.Material[];
        if (names && names.length) {
          const nGroups = g.groups.length ? Math.max(...g.groups.map((gr) => gr.materialIndex ?? 0)) + 1 : 1;
          const arr: THREE.Material[] = [];
          for (let k = 0; k < Math.max(nGroups, 1); k++) {
            const nm = names[Math.min(k, names.length - 1)];
            matNames.add(nm);
            arr.push(getRevitMat(nm));
          }
          mats = g.groups.length ? arr : arr[0];
          const old = mesh.material;
          (Array.isArray(old) ? old : [old]).forEach((m) => m.dispose());
        } else {
          const old = mesh.material;
          mats = Array.isArray(old) ? old.map(convertMat) : convertMat(old);
          (Array.isArray(mats) ? mats : [mats]).forEach((m) => matNames.add(m.name || 'Material'));
        }
        mesh.material = mats;
        mesh.userData.realMats = mats;
        ms.geometries.add(g);
      }
      const box = new THREE.Box3();
      meshes.forEach((m) => { m.updateWorldMatrix(true, false); box.expandByObject(m); });
      const params = (meta && (top as unknown as { ID?: number }).ID !== undefined && meta.modelParams.get((top as unknown as { ID: number }).ID)) || {};
      if (tag?.level) levelHints.set(top.uuid, tag.level);
      elementList.push({
        id: top.uuid, name, revitId, category: tag?.category || categorize(name), level: '', autoLevel: '',
        meshes, box, params, materialNames: [...matNames], hidden: false,
      });
    });

    // --- library
    matCache.forEach((m) => {
      (m as THREE.MeshStandardMaterial).clippingPlanes = ms.planes;
      ms.materials.set(m.name || m.uuid, m);
    });

    // --- levels
    const det = detectLevels(elementList.map((e) => ({ id: e.id, name: e.name, category: e.category, box: e.box })));
    ms.levels = det.levels;
    ms.buildingBox.copy(det.buildingBox);
    for (const lv of ms.levels) {
      const g = new THREE.Group();
      g.name = lv.name;
      g.userData.levelKey = lv.key;
      ms.groups.set(lv.key, g);
      ms.root.add(g);
    }

    // --- flatten: every mesh keeps its world transform, parented to its level group
    const m4 = new THREE.Matrix4();
    for (const el of elementList) {
      el.autoLevel = el.level = det.assignment.get(el.id) ?? ms.levels[0].key;
      const hint = levelHints.get(el.id);
      const hinted = hint && ms.levels.find((l) => l.name === hint);
      if (hinted) el.autoLevel = el.level = hinted.key;
      for (const mesh of el.meshes) {
        m4.copy(mesh.matrixWorld);
        mesh.removeFromParent();
        mesh.children.slice().forEach((c) => mesh.remove(c));
        m4.decompose(mesh.position, mesh.quaternion, mesh.scale);
        mesh.userData.elementId = el.id;
        const isGlass = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every((m) => m.userData.isGlass);
        mesh.castShadow = !isGlass;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        ms.groups.get(el.level)!.add(mesh);
      }
      ms.elements.set(el.id, el);
    }
    ms.root.updateMatrixWorld(true);
    ms.modelBox.setFromObject(ms.root);
    if (ms.buildingBox.isEmpty()) ms.buildingBox.copy(ms.modelBox);

    if (meta && meta.materialNames.length && meta.modelMaterials.size) {
      notes.push('Revit-Materialien liegen als Proxy-Objekte vor; Farben/PBR wurden aus Materialnamen und Autodesk-Assets abgeleitet (Bitmaps sind nicht eingebettet).');
    }
    if (!det.auto) notes.push('Geschosse konnten nicht automatisch erkannt werden – bitte manuell zuweisen.');
    notes.push('Die FBX-Hierarchie enthält keine Ebenen-Knoten; Geschosse wurden geometrisch aus Geschossdecken-Höhen ermittelt.');

    ms.info = {
      fileName, fileSize: buf.byteLength, format,
      application: meta?.application || '–', upAxis: upName, unit: unitName, scaleToMeters: scale,
      meshCount, elementCount: ms.elements.size, triangles: Math.round(triangles),
      materialCount: ms.materials.size, levelsAuto: det.auto,
      revitMaterialProxies: !!meta?.modelMaterials.size, size: ms.modelBox.getSize(new THREE.Vector3()), notes,
    };
    return ms;
  }

  /* ------------------------------------------------------------------ queries */

  visibleMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    this.groups.forEach((g) => {
      if (!g.visible) return;
      g.children.forEach((c) => { if (c.visible && (c as THREE.Mesh).isMesh && c.userData.elementId) out.push(c as THREE.Mesh); });
    });
    return out;
  }

  isClipped(p: THREE.Vector3) {
    return this.planes.some((pl) => pl.distanceToPoint(p) < 0);
  }

  elementBox(ids: Iterable<string>) {
    const b = new THREE.Box3();
    for (const id of ids) {
      const el = this.elements.get(id);
      el?.meshes.forEach((m) => b.expandByObject(m));
    }
    return b;
  }

  /* ------------------------------------------------------------------ state application */

  applyVisibility(levelVisible: Record<string, boolean>) {
    this.groups.forEach((g, k) => (g.visible = levelVisible[k] !== false));
    this.elements.forEach((el) => {
      const vis = !el.hidden && (!this.isolated || this.isolated.has(el.id));
      el.meshes.forEach((m) => (m.visible = vis));
    });
  }

  setLevel(id: string, levelKey: string) {
    const el = this.elements.get(id);
    const g = this.groups.get(levelKey);
    if (!el || !g || el.level === levelKey) return;
    el.level = levelKey;
    el.meshes.forEach((m) => g.add(m)); // local transform == world at explode 0
  }

  applyMaterials() {
    this.elements.forEach((el) => {
      const sel = this.selected.has(el.id);
      for (const m of el.meshes) {
        const real = m.userData.realMats as THREE.Material | THREE.Material[];
        const map = (mat: THREE.Material): THREE.Material => {
          if (sel) return mat.userData.isGlass ? this.whiteGlass : this.highlight;
          if (this.mode === 'white') return mat.userData.isGlass ? this.whiteGlass : this.white;
          if (this.mode === 'wireframe') return this.wire;
          return mat;
        };
        m.material = Array.isArray(real) ? real.map(map) : map(real);
      }
    });
  }

  setExplode(t: number, spacing: number) {
    this.explode = t;
    let i = 0;
    for (const lv of this.levels) {
      const g = this.groups.get(lv.key)!;
      if (lv.kind === 'site') { g.position.y = 0; continue; }
      const idx = lv.kind === 'roof' ? this.levels.filter((l) => l.kind === 'storey').length : i++;
      g.position.y = idx * spacing * t;
      g.updateMatrixWorld(true);
    }
  }

  dispose() {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => {
      Object.values(m).forEach((v) => { if (v instanceof THREE.Texture) v.dispose(); });
      m.dispose();
    });
    [this.white, this.whiteGlass, this.wire, this.highlight].forEach((m) => m.dispose());
    this.root.removeFromParent();
    this.root.clear();
    this.elements.clear();
  }
}

function this_geomStats(g: THREE.BufferGeometry, add: (t: number) => void) {
  const n = g.index ? g.index.count : g.attributes.position?.count ?? 0;
  add(n / 3);
}
