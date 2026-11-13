import * as THREE from 'three';

/**
 * Builds one shared PBR material per Revit material.
 * Priority of the base colour:
 *   1. explicit RGB in the material name ("Lack - grau 80-80-80", "123/118/111")
 *   2. curated architectural rules by keyword (Putz, Klinker, Holz, Glas …)
 *   3. colour from the embedded Autodesk asset (if not plain white)
 *   4. neutral default
 * Revit textures (bitmaps) are not embedded in the FBX, so surfaces are shaded with
 * physically plausible PBR parameters instead of the original bitmaps.
 */

export interface MatSpec {
  color: string;
  roughness: number;
  metalness: number;
  glass?: boolean;
  opacity?: number;
}

const rules: [RegExp, MatSpec][] = [
  [/bildschirm/, { color: '#0b0d10', roughness: 0.15, metalness: 0.2 }],
  [/glas|glass|verglas/, { color: '#9fc3cf', roughness: 0.04, metalness: 0, glass: true, opacity: 0.28 }],
  [/chrom|corom|poliert/, { color: '#d9dbde', roughness: 0.12, metalness: 1 }],
  [/edelstahl|stainless|alumin|alluminio|metall|stahl|wasserhähne/, { color: '#b9bcc0', roughness: 0.35, metalness: 1 }],
  [/klinker/, { color: '#c4a27a', roughness: 0.85, metalness: 0 }],
  [/naturstein/, { color: '#a7a194', roughness: 0.9, metalness: 0 }],
  [/ziegel|dach/, { color: '#55585c', roughness: 0.75, metalness: 0 }],
  [/anthrazit hell/, { color: '#5d6269', roughness: 0.6, metalness: 0 }],
  [/anthrazit/, { color: '#383c41', roughness: 0.55, metalness: 0 }],
  [/putz/, { color: '#ecebe6', roughness: 0.92, metalness: 0 }],
  [/gips|trockenbau/, { color: '#eceae5', roughness: 0.9, metalness: 0 }],
  [/beton/, { color: '#a9a8a3', roughness: 0.9, metalness: 0 }],
  [/granit/, { color: '#8f8f8c', roughness: 0.45, metalness: 0 }],
  [/schüttung/, { color: '#9b9384', roughness: 0.95, metalness: 0 }],
  [/fliesen|porzellan|emaille|becken|keramik/, { color: '#f1f0ec', roughness: 0.15, metalness: 0 }],
  [/mahagoni/, { color: '#6d3a25', roughness: 0.5, metalness: 0 }],
  [/birke/, { color: '#d8c29b', roughness: 0.55, metalness: 0 }],
  [/eiche/, { color: '#b08a5e', roughness: 0.55, metalness: 0 }],
  [/dark wood|dunkel/, { color: '#4b3628', roughness: 0.55, metalness: 0 }],
  [/light wood/, { color: '#cfb086', roughness: 0.55, metalness: 0 }],
  [/holzbalken grau/, { color: '#8e8b85', roughness: 0.8, metalness: 0 }],
  [/bretterschalung|holz|wood|kabuff/, { color: '#a07750', roughness: 0.7, metalness: 0 }],
  [/dämmung/, { color: '#d9d3c5', roughness: 0.95, metalness: 0 }],
  [/erde/, { color: '#7b6b53', roughness: 1, metalness: 0 }],
  [/aufgeschüttet|umgebung/, { color: '#8a7b63', roughness: 1, metalness: 0 }],
  [/tree leaves|laub|blätter/, { color: '#4f7a3b', roughness: 0.9, metalness: 0 }],
  [/trunk|stamm/, { color: '#5a4632', roughness: 0.95, metalness: 0 }],
  [/markierung/, { color: '#f4f4f0', roughness: 0.8, metalness: 0 }],
  [/textil|towel|pelle|leder/, { color: '#d9d6cf', roughness: 1, metalness: 0 }],
  [/kunststoff|plastic/, { color: '#c8c8c8', roughness: 0.45, metalness: 0 }],
  [/weiß|weiss|white/, { color: '#f0efeb', roughness: 0.5, metalness: 0 }],
];

function srgbHex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

export function resolveMaterial(name: string, asset?: [number, number, number]): MatSpec {
  const n = name.toLowerCase();
  let spec: MatSpec = { color: '#c9c6c0', roughness: 0.8, metalness: 0 };
  const rule = rules.find(([re]) => re.test(n));
  if (rule) spec = { ...rule[1] };
  else if (asset && !(asset[0] > 0.99 && asset[1] > 0.99 && asset[2] > 0.99)) spec.color = srgbHex(...asset);

  // Explicit RGB in the material name always wins (e.g. "grau 80-80-80", "Grau120/120/120")
  const rgb = /(\d{2,3})\s*[-/_]\s*(\d{2,3})\s*[-/_]\s*(\d{2,3})(?!\s*(?:mm|cm|x))/.exec(n);
  if (rgb && !spec.glass) {
    const v = [rgb[1], rgb[2], rgb[3]].map(Number);
    if (v.every((x) => x <= 255)) spec.color = srgbHex(v[0] / 255, v[1] / 255, v[2] / 255);
  } else if (!rule && asset && spec.color === '#c9c6c0' && !(asset[0] > 0.99 && asset[1] > 0.99 && asset[2] > 0.99)) {
    spec.color = srgbHex(...asset);
  }
  return spec;
}

export function createPbr(name: string, spec: MatSpec): THREE.MeshStandardMaterial {
  const m = spec.glass
    ? new THREE.MeshPhysicalMaterial({
        name, color: spec.color, roughness: spec.roughness, metalness: spec.metalness,
        transparent: true, opacity: spec.opacity ?? 0.3, depthWrite: false, side: THREE.DoubleSide,
        envMapIntensity: 1.4, clearcoat: 1, clearcoatRoughness: 0.05,
      })
    : new THREE.MeshStandardMaterial({
        name, color: spec.color, roughness: spec.roughness, metalness: spec.metalness, side: THREE.DoubleSide,
      });
  m.userData.originalColor = spec.color;
  m.userData.isGlass = !!spec.glass;
  return m;
}
