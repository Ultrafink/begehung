import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import type { ModelScene } from './model/ModelScene';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Elements you can walk through (door leaves, plants) */
const PASSABLE = new Set(['Türen', 'Bepflanzung']);

export interface World {
  group: THREE.Group;
  colliders: THREE.Mesh[];
  building: THREE.Box3;
  spawn: THREE.Vector3;
  lookAt: THREE.Vector3;
}

interface Bucket { material: THREE.Material; solid: boolean; pos: number[]; nrm: number[] }

/**
 * Bakes every element into one mesh per (material, walkable-through) pair:
 * ~90 draw calls instead of ~3 400, and the same meshes serve as BVH colliders.
 * Geometry is copied 1:1 in world space (metres), nothing is simplified.
 */
export function buildWorld(m: ModelScene): World {
  const buckets = new Map<string, Bucket>();
  const chunkIdx = new Map<string, number>();
  const MAX_TRI = 60000;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  const canopies: THREE.Box3[] = [];

  m.root.updateMatrixWorld(true);
  m.elements.forEach((el) => {
    const solid = !PASSABLE.has(el.category);
    for (const mesh of el.meshes) {
      const g = mesh.geometry;
      const P = g.attributes.position;
      const N = g.attributes.normal;
      const idx = g.index;
      const mats = (Array.isArray(mesh.userData.realMats) ? mesh.userData.realMats : [mesh.userData.realMats]) as THREE.Material[];
      const groups = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : P.count, materialIndex: 0 }];
      nm.getNormalMatrix(mesh.matrixWorld);
      for (const gr of groups) {
        const mat = mats[Math.min(gr.materialIndex ?? 0, mats.length - 1)];
        if (mat.name.toLowerCase().includes('vordach')) {
          canopies.push(new THREE.Box3().setFromObject(mesh));
        }
        // chunk each (material, solid) batch at ~60k triangles: better culling, no giant draw calls
        const base = mat.uuid + (solid ? '|s' : '|p');
        let part = chunkIdx.get(base) ?? 0;
        let b = buckets.get(base + part);
        if (b && b.pos.length > MAX_TRI * 9) { part++; chunkIdx.set(base, part); b = undefined; }
        if (!b) buckets.set(base + part, (b = { material: mat, solid, pos: [], nrm: [] }));
        for (let i = gr.start; i < gr.start + gr.count; i++) {
          const k = idx ? idx.getX(i) : i;
          v.fromBufferAttribute(P, k).applyMatrix4(mesh.matrixWorld);
          b.pos.push(v.x, v.y, v.z);
          if (N) { n.fromBufferAttribute(N, k).applyMatrix3(nm).normalize(); b.nrm.push(n.x, n.y, n.z); }
          else b.nrm.push(0, 1, 0);
        }
      }
      g.dispose(); // source geometry no longer needed
    }
  });

  const group = new THREE.Group();
  const colliders: THREE.Mesh[] = [];
  buckets.forEach((b) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    geo.computeBoundingSphere();
    const mat = b.material as THREE.MeshStandardMaterial;
    mat.clippingPlanes = null;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = mat.name;
    mesh.matrixAutoUpdate = false;
    const glass = !!mat.userData.isGlass;
    mesh.castShadow = !glass;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (b.solid) { geo.computeBoundsTree(); colliders.push(mesh); }
  });

  // start position: in front of the main entrance =
  // a ground-floor door on the outer facade, preferably one under a glass canopy (Vordach)
  const building = m.buildingBox.clone();
  const walls = new THREE.Box3();
  m.elements.forEach((el) => { if (el.category === 'Wände' && el.level !== 'SITE') walls.union(el.box); });
  if (walls.isEmpty()) walls.copy(building);
  const faces = [
    { d: new THREE.Vector3(1, 0, 0), at: (p: THREE.Vector3) => Math.abs(p.x - walls.max.x) },
    { d: new THREE.Vector3(-1, 0, 0), at: (p: THREE.Vector3) => Math.abs(p.x - walls.min.x) },
    { d: new THREE.Vector3(0, 0, 1), at: (p: THREE.Vector3) => Math.abs(p.z - walls.max.z) },
    { d: new THREE.Vector3(0, 0, -1), at: (p: THREE.Vector3) => Math.abs(p.z - walls.min.z) },
  ];
  let target = walls.getCenter(new THREE.Vector3());
  let dir = new THREE.Vector3(1, 0, 0);
  let bestScore = Infinity;
  m.elements.forEach((el) => {
    if (el.category !== 'Türen' || el.level === 'SITE' || el.box.min.y > walls.min.y + 1.5) return;
    const c = el.box.getCenter(new THREE.Vector3());
    const face = faces.reduce((a, f) => (f.at(c) < a.at(c) ? f : a));
    if (face.at(c) > 1.2) return; // interior door
    const canopy = canopies.some((cb) => cb.clone().expandByScalar(1.5).containsPoint(new THREE.Vector3(c.x, cb.min.y, c.z)));
    const score = (canopy ? 0 : 100) + face.at(c);
    if (score < bestScore) { bestScore = score; target = c; dir = face.d.clone(); }
  });
  if (bestScore === Infinity) {
    const s = walls.getSize(new THREE.Vector3());
    dir = s.z > s.x ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  }
  const spawn = new THREE.Vector3(target.x, 0, target.z).addScaledVector(dir, 9);
  spawn.y = groundAt(colliders, spawn, building.max.y + 20) ?? building.min.y;
  const lookAt = new THREE.Vector3(target.x, spawn.y + 1.65, target.z);
  return { group, colliders, building, spawn, lookAt };
}

const down = new THREE.Raycaster();
down.firstHitOnly = true;
export function groundAt(colliders: THREE.Mesh[], p: THREE.Vector3, fromY: number): number | null {
  down.set(new THREE.Vector3(p.x, fromY, p.z), new THREE.Vector3(0, -1, 0));
  down.far = 500;
  const h = down.intersectObjects(colliders, false)[0];
  return h ? h.point.y : null;
}
