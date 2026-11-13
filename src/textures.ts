import * as THREE from 'three';

/**
 * Procedural surface textures, generated on a canvas at start-up (no external files, no licences).
 * They are grey "detail" maps (mean ≈ 0.85) multiplied onto the Revit base colour, so the
 * architect's colours stay intact. Mapping is triplanar in world metres: no UVs needed, a brick
 * is always 24 cm wide, joints always horizontal. Luminance doubles as a bump map (joints recess).
 */

type Kind = 'brick' | 'roof' | 'boardsV' | 'boardsH' | 'plaster' | 'concrete' | 'grass' | 'pavers' | 'tiles' | 'stone' | 'gravel';

interface TexDef { kind: Kind; size: [number, number]; bump: number; color?: string }

/** Material name → texture. First match wins. */
const RULES: [RegExp, TexDef][] = [
  [/glas|chrom|edelstahl|alumin|metall|stahl(?!beton)|kunststoff - glatt|tv -|bildschirm|corom|towel|leder|pelle|textil/, { kind: 'plaster', size: [0, 0], bump: 0 }], // none (size 0)
  [/klinker/, { kind: 'brick', size: [1.0, 0.65], bump: 2.2 }],
  [/naturstein/, { kind: 'stone', size: [0.8, 0.8], bump: 1.2 }],
  [/bretterschalung vertikal/, { kind: 'boardsV', size: [0.9, 2.4], bump: 1.4 }],
  [/bretterschalung/, { kind: 'boardsH', size: [2.4, 0.9], bump: 1.4 }],
  [/erde/, { kind: 'grass', size: [2.5, 2.5], bump: 0.8, color: '#7d9a52' }],
  [/aufgeschüttet/, { kind: 'concrete', size: [3, 3], bump: 0.2, color: '#b8b3aa' }],
  [/beton - unbewehrt/, { kind: 'pavers', size: [1.2, 1.2], bump: 1.6 }],
  [/fliesen|granit/, { kind: 'tiles', size: [1.0, 1.0], bump: 1.0 }],
  [/beton/, { kind: 'concrete', size: [3, 3], bump: 0.35 }],
  [/putz|gips|trockenbau|white paint|weiß/, { kind: 'plaster', size: [1.6, 1.6], bump: 0.25 }],
  [/holz|wood/, { kind: 'boardsH', size: [1.6, 0.6], bump: 0.6 }],
];

const ROOF: TexDef = { kind: 'roof', size: [1.2, 1.2], bump: 2.4 };

/* ------------------------------------------------------------------ canvas painting */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function paint(kind: Kind, W: number, H: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const r = rng(kind.length * 9973 + W);
  const fill = (v: number) => `rgb(${v},${v},${v})`;
  const noise = (amount: number, size = 1, alpha = 0.5) => {
    const img = g.getImageData(0, 0, W, H);
    for (let y = 0; y < H; y += size) for (let x = 0; x < W; x += size) {
      const d = (r() - 0.5) * amount;
      for (let yy = y; yy < Math.min(H, y + size); yy++) for (let xx = x; xx < Math.min(W, x + size); xx++) {
        const i = (yy * W + xx) * 4;
        for (let k = 0; k < 3; k++) img.data[i + k] = Math.max(0, Math.min(255, img.data[i + k] + d * alpha));
      }
    }
    g.putImageData(img, 0, 0);
  };
  const blotches = (n: number, rad: number, lo: number, hi: number, a = 0.08) => {
    for (let i = 0; i < n; i++) {
      const x = r() * W, y = r() * H, rr = rad * (0.4 + r());
      const v = Math.round(lo + r() * (hi - lo));
      const grd = g.createRadialGradient(x, y, 0, x, y, rr);
      grd.addColorStop(0, `rgba(${v},${v},${v},${a})`); grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = grd;
      for (const ox of [-W, 0, W]) for (const oy of [-H, 0, H]) { g.save(); g.translate(ox, oy); g.fillRect(x - rr, y - rr, rr * 2, rr * 2); g.restore(); }
    }
  };

  switch (kind) {
    case 'brick': { // NF 240 × 71 mm, 10 mm joints, running bond; 4 × 8 bricks per tile (1.00 × 0.65 m)
      g.fillStyle = fill(150); g.fillRect(0, 0, W, H);
      const bw = W / 4, bh = H / 8, j = Math.max(2, W / 100);
      for (let row = 0; row < 8; row++) for (let col = -1; col < 5; col++) {
        const x = col * bw + (row % 2 ? bw / 2 : 0), y = row * bh;
        g.fillStyle = fill(Math.round(205 + (r() - 0.5) * 50));
        g.fillRect(x + j / 2, y + j / 2, bw - j, bh - j);
      }
      noise(26, 1, 0.6); noise(30, 4, 0.35);
      break;
    }
    case 'roof': { // concrete/clay tiles, rows of 30 cm, staggered, shadowed lower edge
      g.fillStyle = fill(200); g.fillRect(0, 0, W, H);
      const rows = 4, cols = 4, th = H / rows, tw = W / cols;
      for (let row = 0; row < rows; row++) for (let col = -1; col <= cols; col++) {
        const x = col * tw + (row % 2 ? tw / 2 : 0), y = row * th;
        const base = 200 + (r() - 0.5) * 30;
        const grd = g.createLinearGradient(0, y, 0, y + th);
        grd.addColorStop(0, fill(Math.round(base + 12))); grd.addColorStop(0.85, fill(Math.round(base - 10))); grd.addColorStop(1, fill(95));
        g.fillStyle = grd; g.fillRect(x + 2, y, tw - 4, th);
        g.fillStyle = fill(120); g.fillRect(x, y, 3, th);
      }
      noise(24, 2, 0.5);
      break;
    }
    case 'boardsV':
    case 'boardsH': { // 12–16 cm boards with grain and 6 mm gaps
      const vertical = kind === 'boardsV';
      const L = vertical ? W : H, n = vertical ? 6 : 5;
      g.fillStyle = fill(110); g.fillRect(0, 0, W, H);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * L, b = ((i + 1) / n) * L - Math.max(2, L / 90);
        const base = 200 + (r() - 0.5) * 36;
        g.fillStyle = fill(Math.round(base));
        vertical ? g.fillRect(a, 0, b - a, H) : g.fillRect(0, a, W, b - a);
        for (let k = 0; k < 40; k++) { // grain
          const p = a + r() * (b - a);
          g.strokeStyle = `rgba(80,80,80,${0.05 + r() * 0.08})`; g.lineWidth = 0.5 + r() * 1.5;
          g.beginPath();
          if (vertical) { g.moveTo(p, 0); g.bezierCurveTo(p + (r() - 0.5) * 6, H / 3, p + (r() - 0.5) * 6, (2 * H) / 3, p, H); }
          else { g.moveTo(0, p); g.bezierCurveTo(W / 3, p + (r() - 0.5) * 6, (2 * W) / 3, p + (r() - 0.5) * 6, W, p); }
          g.stroke();
        }
      }
      noise(14, 1, 0.5);
      break;
    }
    case 'plaster':
      g.fillStyle = fill(222); g.fillRect(0, 0, W, H);
      blotches(60, W / 5, 190, 245, 0.12); noise(18, 1, 0.7); noise(12, 3, 0.5);
      break;
    case 'concrete':
      g.fillStyle = fill(210); g.fillRect(0, 0, W, H);
      blotches(90, W / 6, 170, 240, 0.14); noise(22, 1, 0.7);
      for (let i = 0; i < 70; i++) { g.fillStyle = fill(170 + r() * 40); g.beginPath(); g.arc(r() * W, r() * H, 0.6 + r() * 1.4, 0, 7); g.fill(); }
      break;
    case 'grass':
      g.fillStyle = fill(185); g.fillRect(0, 0, W, H);
      blotches(80, W / 4, 150, 240, 0.25);
      for (let i = 0; i < 9000; i++) {
        const x = r() * W, y = r() * H, l = 3 + r() * 7;
        g.strokeStyle = fill(Math.round(140 + r() * 110)); g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 3, y - l); g.stroke();
      }
      break;
    case 'pavers': { // 20 × 10 cm concrete pavers, running bond
      g.fillStyle = fill(120); g.fillRect(0, 0, W, H);
      const cols = 6, rows = 12, pw = W / cols, ph = H / rows, j = Math.max(2, W / 260);
      for (let row = 0; row < rows; row++) for (let col = -1; col <= cols; col++) {
        const x = col * pw + (row % 2 ? pw / 2 : 0), y = row * ph;
        g.fillStyle = fill(Math.round(208 + (r() - 0.5) * 26)); g.fillRect(x + j, y + j, pw - 2 * j, ph - 2 * j);
      }
      noise(22, 1, 0.6);
      break;
    }
    case 'tiles': { // 50 × 50 cm, 3 mm grout
      g.fillStyle = fill(150); g.fillRect(0, 0, W, H);
      const n = 2, s = W / n, j = Math.max(2, W / 300);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.fillStyle = fill(Math.round(220 + (r() - 0.5) * 14)); g.fillRect(x * s + j, y * s + j, s - 2 * j, s - 2 * j); }
      blotches(30, W / 6, 190, 240, 0.08); noise(10, 1, 0.5);
      break;
    }
    case 'stone':
      g.fillStyle = fill(205); g.fillRect(0, 0, W, H);
      blotches(120, W / 10, 150, 245, 0.2); noise(30, 1, 0.6);
      break;
    case 'gravel':
      g.fillStyle = fill(150); g.fillRect(0, 0, W, H);
      for (let i = 0; i < 2600; i++) { g.fillStyle = fill(Math.round(150 + r() * 100)); g.beginPath(); g.ellipse(r() * W, r() * H, 2 + r() * 5, 2 + r() * 4, r() * 3, 0, 7); g.fill(); }
      noise(12, 1, 0.5);
      break;
  }
  return c;
}

const cache = new Map<Kind, THREE.CanvasTexture>();
function texture(kind: Kind, renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  let t = cache.get(kind);
  if (t) return t;
  const H = kind === 'brick' ? 333 : 512;
  t = new THREE.CanvasTexture(paint(kind, 512, H));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.generateMipmaps = true;
  cache.set(kind, t);
  return t;
}

/* ------------------------------------------------------------------ triplanar shader patch */

function patch(mat: THREE.MeshStandardMaterial, tex: THREE.Texture, def: TexDef) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.triMap = { value: tex };
    sh.uniforms.triScale = { value: new THREE.Vector2(...def.size) };
    sh.uniforms.triBump = { value: def.bump };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriP;\nvarying vec3 vTriN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTriP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTriN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D triMap; uniform vec2 triScale; uniform float triBump;
varying vec3 vTriP; varying vec3 vTriN;
float triH;
vec3 triPerturb(vec3 p, vec3 n, vec2 dH, float fd) {
  vec3 sx = normalize(dFdx(p)); vec3 sy = normalize(dFdy(p));
  vec3 r1 = cross(sy, n); vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * fd;
  return normalize(abs(det) * n - sign(det) * (dH.x * r1 + dH.y * r2));
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec3 w = pow(abs(normalize(vTriN)), vec3(4.0)); w /= (w.x + w.y + w.z);
  vec4 t = texture2D(triMap, vec2(vTriP.z, vTriP.y) / triScale) * w.x
         + texture2D(triMap, vec2(vTriP.x, vTriP.z) / triScale.xx) * w.y
         + texture2D(triMap, vec2(vTriP.x, vTriP.y) / triScale) * w.z;
  diffuseColor.rgb *= t.rgb * 1.18;
  triH = dot(t.rgb, vec3(0.3333));
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = triPerturb(-vViewPosition, normal, vec2(dFdx(triH), dFdy(triH)) * triBump, faceDirection);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (0.6 - triH) * 0.25, 0.04, 1.0);`);
  };
  mat.customProgramCacheKey = () => 'tri-' + def.kind;
  mat.needsUpdate = true;
}

/** Applies a texture to a library material (in place). Returns true if textured. */
export function texturize(mat: THREE.Material, renderer: THREE.WebGLRenderer): boolean {
  const m = mat as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || m.userData.isGlass || m.userData.textured) return false;
  const name = m.name.toLowerCase();
  const rule = RULES.find(([re]) => re.test(name));
  if (!rule || rule[1].size[0] === 0) return false;
  const def = rule[1];
  if (def.color) m.color.set(def.color);
  patch(m, texture(def.kind, renderer), def);
  m.userData.textured = true;
  return true;
}

/** Roof covering variant (Revit roof elements carry a generic grey material). */
export function roofMaterial(base: THREE.Material, renderer: THREE.WebGLRenderer): THREE.MeshStandardMaterial {
  const m = (base as THREE.MeshStandardMaterial).clone();
  m.name = base.name + ' (Dachziegel)';
  m.color.set('#5b5e62');
  m.roughness = 0.7;
  patch(m, texture('roof', renderer), ROOF);
  m.userData = { ...base.userData, textured: true };
  return m;
}
