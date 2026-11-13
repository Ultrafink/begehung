/**
 * Lightweight reader for the parts of an FBX file that three.js' FBXLoader ignores:
 *  - GlobalSettings (UpAxis, UnitScaleFactor) -> correct orientation and metres
 *  - Revit "ProxyObject_*" material proxies (Revit 2026 writes materials as
 *    generic Objects instead of FBX Materials, so FBXLoader sees none)
 *  - the embedded ADSKAssetReferences blob (zip with Autodesk Protein XML) -> base colours
 *  - ObjectMetaData (Revit parameters such as "Abhängigkeit unten")
 *
 * Geometry itself is NOT parsed here – it comes unchanged from FBXLoader.
 */
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';

export interface FbxMeta {
  format: 'binary' | 'ascii';
  version: number;
  application: string;
  upAxis: number; // 0 = X, 1 = Y, 2 = Z
  upAxisSign: number;
  unitScaleFactor: number; // centimetres per file unit
  /** FBX Model id -> ordered material proxy names (material index order) */
  modelMaterials: Map<number, string[]>;
  /** FBX Model id -> Revit parameters */
  modelParams: Map<number, Record<string, string>>;
  /** material proxy name -> linear-ish sRGB colour from the Autodesk asset (if any) */
  assetColors: Map<string, [number, number, number]>;
  materialNames: string[];
}

const td = new TextDecoder('utf-8');

interface RawNode {
  name: string;
  props: unknown[];
  children: RawNode[];
}

const WANTED_TOP = new Set(['GlobalSettings', 'Objects', 'Connections', 'FBXHeaderExtension']);

function readBinary(buf: ArrayBuffer): { version: number; top: RawNode[] } {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const version = dv.getUint32(23, true);
  const big = version >= 7500;

  const readNode = (off: number, depth: number, keep: boolean): { node: RawNode | null; end: number } => {
    let end: number, nProps: number;
    let p = off;
    if (big) {
      end = Number(dv.getBigUint64(p, true));
      nProps = Number(dv.getBigUint64(p + 8, true));
      p += 24;
    } else {
      end = dv.getUint32(p, true);
      nProps = dv.getUint32(p + 4, true);
      p += 12;
    }
    const nameLen = u8[p];
    p += 1;
    if (end === 0) return { node: null, end: p + nameLen };
    const name = td.decode(u8.subarray(p, p + nameLen));
    p += nameLen;
    if (depth === 0 && !WANTED_TOP.has(name)) return { node: { name, props: [], children: [] }, end };
    // Skip heavy geometry nodes entirely
    if (name === 'Geometry' || name === 'Takes' || name === 'AnimationCurve') return { node: { name, props: [], children: [] }, end };
    const props: unknown[] = [];
    for (let i = 0; i < nProps; i++) {
      const t = String.fromCharCode(u8[p]);
      p += 1;
      switch (t) {
        case 'Y': props.push(dv.getInt16(p, true)); p += 2; break;
        case 'C': props.push(u8[p] !== 0); p += 1; break;
        case 'I': props.push(dv.getInt32(p, true)); p += 4; break;
        case 'F': props.push(dv.getFloat32(p, true)); p += 4; break;
        case 'D': props.push(dv.getFloat64(p, true)); p += 8; break;
        case 'L': props.push(Number(dv.getBigInt64(p, true))); p += 8; break;
        case 'S': {
          const l = dv.getUint32(p, true); p += 4;
          props.push(td.decode(u8.subarray(p, p + l))); p += l; break;
        }
        case 'R': {
          const l = dv.getUint32(p, true); p += 4;
          props.push(u8.subarray(p, p + l)); p += l; break;
        }
        case 'f': case 'd': case 'l': case 'i': case 'b': {
          const cl = dv.getUint32(p + 8, true);
          p += 12 + cl; props.push(null); break; // arrays not needed
        }
        default:
          throw new Error(`Unbekannter FBX-Property-Typ "${t}"`);
      }
    }
    const children: RawNode[] = [];
    while (p < end) {
      const r = readNode(p, depth + 1, keep);
      p = r.end;
      if (!r.node) break;
      children.push(r.node);
    }
    return { node: { name, props, children }, end };
  };

  const top: RawNode[] = [];
  let off = 27;
  while (off < buf.byteLength - 13) {
    const r = readNode(off, 0, true);
    if (!r.node) break;
    top.push(r.node);
    off = r.end;
  }
  return { version, top };
}

const cleanName = (s: string) => s.split('\u0000')[0];

function props70(node: RawNode | undefined): Map<string, unknown[]> {
  const m = new Map<string, unknown[]>();
  const p70 = node?.children.find((c) => c.name === 'Properties70');
  p70?.children.forEach((p) => m.set(String(p.props[0]), p.props));
  return m;
}

function parseAssetColors(blob: Uint8Array): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  try {
    const files = unzipSync(blob);
    const key = Object.keys(files).find((k) => k.endsWith('objects.xml'));
    if (!key) return out;
    const xml = td.decode(files[key]);
    const re = /<node name="\d+" class="schema\.autodesk\.data\.gfx\.1\.material">([\s\S]*?)<\/node>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const body = m[1];
      const id = /<string name="ID"><name locale="fbx">I<\/name><val>([^<]+)<\/val>/.exec(body)?.[1];
      const col = /<vector4 name="([a-z_]*(?:color|diffuse))"><name locale="fbx">[A-Z]*<\/name> <val>([^<]+)<\/val>/.exec(body);
      if (id && col) {
        const v = col[2].trim().split(/\s+/).map(Number);
        out.set(id, [v[0], v[1], v[2]]);
      }
    }
  } catch (e) {
    console.warn('ADSK-Asset-Blob konnte nicht gelesen werden', e);
  }
  return out;
}

export function readFbxMeta(buf: ArrayBuffer): FbxMeta {
  const head = td.decode(new Uint8Array(buf, 0, Math.min(20, buf.byteLength)));
  const meta: FbxMeta = {
    format: 'binary', version: 0, application: '', upAxis: 1, upAxisSign: 1, unitScaleFactor: 1,
    modelMaterials: new Map(), modelParams: new Map(), assetColors: new Map(), materialNames: [],
  };

  if (!head.startsWith('Kaydara FBX Binary')) {
    // ASCII FBX: only read global settings
    meta.format = 'ascii';
    const text = td.decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 4_000_000)));
    const num = (k: string) => {
      const r = new RegExp(`"${k}"\\s*,\\s*"[^"]*"\\s*,\\s*"[^"]*"\\s*,\\s*"[^"]*"\\s*,\\s*(-?[\\d.]+)`).exec(text);
      return r ? Number(r[1]) : undefined;
    };
    meta.upAxis = num('UpAxis') ?? 1;
    meta.upAxisSign = num('UpAxisSign') ?? 1;
    meta.unitScaleFactor = num('UnitScaleFactor') ?? 1;
    meta.version = Number(/FBXVersion:\s*(\d+)/.exec(text)?.[1] ?? 0);
    return meta;
  }

  const { version, top } = readBinary(buf);
  meta.version = version;
  const T = new Map(top.map((n) => [n.name, n]));

  const gs = props70(T.get('GlobalSettings'));
  meta.upAxis = Number(gs.get('UpAxis')?.[4] ?? 1);
  meta.upAxisSign = Number(gs.get('UpAxisSign')?.[4] ?? 1);
  meta.unitScaleFactor = Number(gs.get('UnitScaleFactor')?.[4] ?? 1);

  const sceneInfo = T.get('FBXHeaderExtension')?.children.find((c) => c.name === 'SceneInfo');
  meta.application = String(props70(sceneInfo).get('Original|ApplicationName')?.[4] ?? '');

  const objects = T.get('Objects')?.children ?? [];
  const byId = new Map<number, RawNode>();
  objects.forEach((o) => byId.set(o.props[0] as number, o));

  // Material proxies + asset colours
  const proxyName = new Map<number, string>();
  const proxyAsset = new Map<string, string>();
  let assetColorsById = new Map<string, [number, number, number]>();
  for (const o of objects) {
    if (o.name === 'Material') {
      proxyName.set(o.props[0] as number, cleanName(String(o.props[1])));
    }
    if (o.name !== 'Object') continue;
    const nm = cleanName(String(o.props[1]));
    const p = props70(o);
    if (nm.startsWith('ProxyObject_')) {
      const n = nm.slice('ProxyObject_'.length) || 'Unbenannt';
      proxyName.set(o.props[0] as number, n);
      const aid = p.get('ADSKAssetReferenceID')?.[4];
      if (aid) proxyAsset.set(n, String(aid));
    } else if (nm === 'ADSKAssetReferences') {
      const blobProp = o.children.find((c) => c.name === 'Properties70')?.children[0];
      const raw = blobProp?.children.find((c) => c.name === 'BinaryData')?.props[0];
      if (raw instanceof Uint8Array) assetColorsById = parseAssetColors(raw);
    }
  }
  proxyAsset.forEach((aid, n) => {
    const c = assetColorsById.get(aid);
    if (c) meta.assetColors.set(n, c);
  });
  meta.materialNames = [...new Set(proxyName.values())];

  // Connections: materials and metadata -> models (order = material index)
  const conns = T.get('Connections')?.children ?? [];
  for (const c of conns) {
    const child = c.props[1] as number;
    const parent = c.props[2] as number;
    const pn = byId.get(parent);
    if (!pn || pn.name !== 'Model') continue;
    const mat = proxyName.get(child);
    if (mat !== undefined) {
      let arr = meta.modelMaterials.get(parent);
      if (!arr) meta.modelMaterials.set(parent, (arr = []));
      arr.push(mat);
      continue;
    }
    const cn = byId.get(child);
    if (cn?.name === 'ObjectMetaData') {
      const rec: Record<string, string> = {};
      props70(cn).forEach((v, k) => {
        if (v.length > 4 && v[4] !== '' && v[4] !== undefined) rec[k] = String(v[4]);
      });
      if (Object.keys(rec).length) meta.modelParams.set(parent, rec);
    }
  }
  return meta;
}
