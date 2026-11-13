import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ModelScene } from './model/ModelScene';
import { buildWorld } from './world';
import { texturize, roofMaterial } from './textures';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Player } from './player';
import './style.css';

const MODEL = import.meta.env.BASE_URL + 'models/2025_0722_MFHEldagsen-LPH4-3D-Ansicht-_3D_.fbx';
const HDRI = import.meta.env.BASE_URL + 'hdri/rooitou_park_1k.hdr';

const $ = (id: string) => document.getElementById(id)!;
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
document.body.classList.toggle('is-touch', isTouch);

/* ---------------------------------------------------------------- renderer + scene */
const canvas = $('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch || devicePixelRatio < 2, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true; // computed once at load, cheap even on phones
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // static sun + static building: render shadows once

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 3000);
const resize = () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
};
// desktop: ambient occlusion (soft darkening in corners, joints, under furniture)
let composer: EffectComposer | null = null;
let gtao: GTAOPass | null = null;
if (!isTouch) {
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  gtao = new GTAOPass(scene, camera, 1, 1);
  gtao.blendIntensity = 0.9;
  gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.2, thickness: 1.5, scale: 1.0, samples: 12 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
}
addEventListener('resize', () => { resize(); composer?.setSize(innerWidth, innerHeight); composer?.setPixelRatio(renderer.getPixelRatio()); });
resize();
composer?.setSize(innerWidth, innerHeight);

scene.add(new THREE.HemisphereLight('#dfe8f2', '#5a5248', 0.35));
const sun = new THREE.DirectionalLight('#fff3e2', 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(isTouch ? 2048 : 4096, isTouch ? 2048 : 4096);
sun.shadow.radius = 2;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

/* ---------------------------------------------------------------- loading */
async function fetchModel(): Promise<ArrayBuffer> {
  const res = await fetch(MODEL);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${MODEL}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got);
    got += value.length;
    progress(got / total * 0.7, 'Modell wird geladen …');
  }
  return out.buffer;
}
function progress(p: number, stage: string) {
  ($('bar') as HTMLElement).style.width = `${Math.round(p * 100)}%`;
  $('pct').textContent = `${Math.round(p * 100)} %`;
  $('stage').textContent = stage;
}
const frame = () => new Promise((r) => setTimeout(r, 30));

let player: Player | null = null;

async function init() {
  const [buf, env] = await Promise.all([
    fetchModel(),
    new RGBELoader().loadAsync(HDRI),
  ]);
  progress(0.75, 'Geometrie wird aufbereitet …');
  await frame();
  const model = await ModelScene.load(buf, 'model.fbx');
  progress(0.88, 'Begehbare Flächen werden berechnet …');
  await frame();
  const roofs = new Map<THREE.Material, THREE.Material>();
  const world = buildWorld(model, (mat, elName) => {
    if (/ziegel/i.test(elName) && /kunststoff|dach|ziegel/i.test(mat.name)) {
      let r = roofs.get(mat);
      if (!r) roofs.set(mat, (r = roofMaterial(mat, renderer)));
      return r;
    }
    texturize(mat, renderer);
    return mat;
  });
  scene.add(world.group);

  env.mapping = THREE.EquirectangularReflectionMapping;
  // sky from the HDRI, but neutral image-based light: the park HDRI's green ground
  // would otherwise tint ceilings indoors (environment light has no occlusion)
  scene.background = env;
  scene.backgroundBlurriness = 0.03;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.75;
  // windows and metal reflect the real sky instead of the neutral studio light
  const sky = new THREE.PMREMGenerator(renderer);
  const skyEnv = sky.fromEquirectangular(env).texture;
  sky.dispose();
  world.group.traverse((o) => {
    const mm = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!mm?.isMeshStandardMaterial) return;
    if (mm.userData.isGlass || mm.metalness > 0.5) { mm.envMap = skyEnv; mm.envMapIntensity = mm.userData.isGlass ? 1.6 : 1.0; }
  });

  // afternoon sun from south-west, shadow frustum fitted to the building
  const sphere = world.building.getBoundingSphere(new THREE.Sphere());
  const R = sphere.radius * 1.15;
  sun.position.copy(sphere.center).add(new THREE.Vector3(-0.45, 0.75, 0.5).normalize().multiplyScalar(R * 2.5));
  sun.target.position.copy(sphere.center);
  Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 0.5, far: R * 5 });
  sun.shadow.camera.updateProjectionMatrix();
  renderer.shadowMap.needsUpdate = true;

  player = new Player(camera, world.colliders);
  player.place(world.spawn, world.lookAt);
  if (location.search.includes('debug')) Object.assign(window, { __walk: { player, renderer, scene, camera, render: () => (composer ? composer.render() : renderer.render(scene, camera)) } });
  renderer.compile(scene, camera);

  $('loading').classList.add('hidden');
  $('start').classList.remove('hidden');
}

/* ---------------------------------------------------------------- input */
const startBtn = $('go');
startBtn.addEventListener('click', () => {
  $('start').classList.add('hidden');
  if (isTouch) $('pad').classList.remove('hidden');
  else canvas.requestPointerLock?.();
});

// desktop: pointer lock look; show the start card again when the mouse is released
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && !isTouch && player) {
    ($('go') as HTMLButtonElement).textContent = 'Weiter';
    $('start').classList.remove('hidden');
  }
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas && player) player.look(e.movementX * 0.0022, e.movementY * 0.0022);
});

// touch / pen / mouse-drag fallback: drag on the picture to look around
let dragId: number | null = null;
let lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  if (document.pointerLockElement) return;
  if (!isTouch && $('start').classList.contains('hidden') === false) return;
  dragId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== dragId || !player) return;
  const k = isTouch ? 0.005 : 0.004;
  player.look((e.clientX - lastX) * k, (e.clientY - lastY) * k);
  lastX = e.clientX; lastY = e.clientY;
});
const endDrag = (e: PointerEvent) => { if (e.pointerId === dragId) dragId = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// on-screen arrow buttons (hold to walk, several at once for diagonals)
const held = new Set<string>();
const syncPad = () => {
  if (!player) return;
  player.touchMove.set((held.has('r') ? 1 : 0) - (held.has('l') ? 1 : 0), (held.has('f') ? 1 : 0) - (held.has('b') ? 1 : 0));
};
document.querySelectorAll<HTMLButtonElement>('#pad button').forEach((b) => {
  const dir = b.dataset.dir!;
  const on = (e: PointerEvent) => { e.preventDefault(); b.setPointerCapture(e.pointerId); held.add(dir); b.classList.add('on'); syncPad(); };
  const off = () => { held.delete(dir); b.classList.remove('on'); syncPad(); };
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off);
  b.addEventListener('lostpointercapture', off);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
});

/* ---------------------------------------------------------------- loop */
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (player && $('start').classList.contains('hidden')) player.update(dt);
  if (composer) composer.render(); else renderer.render(scene, camera);
});

init().catch((e) => {
  console.error(e);
  $('loading').classList.add('hidden');
  $('error').classList.remove('hidden');
  $('errmsg').textContent = e instanceof Error ? e.message : String(e);
});
