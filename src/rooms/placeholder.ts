// 仮の部屋。各部屋の担当が本実装に置き換えるまで、レールに沿った目印と触れられる玉を置く。
import * as THREE from 'three/webgpu';
import type { Cue, Vec3Tuple } from '../contracts/events';
import type { RoomId, SectionId } from '../contracts/ids';
import type { Atmosphere, RoomContext, RoomFrame, RoomModule, Touchable } from '../contracts/room';
import { createGlass, type GlassHandle } from '../core/materials/glass';

// 毎フレームの確保を避けるための作業用（書き換えない）
const ONE = new THREE.Vector3(1, 1, 1);

export interface PlaceholderSpec {
  readonly id: RoomId;
  /** この部屋が受け持つ区間（乗り場は platform と departure） */
  readonly sections: readonly SectionId[];
  readonly color: THREE.ColorRepresentation;
  readonly atmosphere: Atmosphere;
}

export function createPlaceholderRoom(spec: PlaceholderSpec): RoomModule {
  const root = new THREE.Group();
  root.name = `room:${spec.id}`;
  const touchables: Touchable[] = [];
  const handles: GlassHandle[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  let ctxRef: RoomContext | null = null;

  return {
    id: spec.id,
    root,
    touchables,
    atmosphere: spec.atmosphere,
    async load(ctx) {
      ctxRef = ctx;
      const ring = new THREE.TorusGeometry(3.2, 0.05, 8, 48);
      const orb = new THREE.IcosahedronGeometry(0.35, 2);
      geometries.push(ring, orb);
      const ringGlass = createGlass('iridescent', { color: spec.color, opacity: 0.5 });
      handles.push(ringGlass);
      for (const section of spec.sections) {
        if (section === 'departure' && spec.sections.length > 1) continue;
        const span = ctx.ride.sectionSpan(section);
        for (let s = span.s0; s < span.s1; s += 12) {
          const p = ctx.ride.pointAt(s);
          const r = new THREE.Mesh(ring, ringGlass.material);
          r.position.set(p.x, p.y, p.z);
          r.rotation.y = p.yaw;
          root.add(r);
        }
        let n = 0;
        for (let s = span.s0 + 6; s < span.s1; s += 24) {
          const p = ctx.ride.pointAt(s);
          const side = n % 2 === 0 ? 1 : -1;
          const glass = createGlass('tinted', { color: spec.color, opacity: 0.8, emissive: spec.color, emissiveIntensity: 0.4 });
          handles.push(glass);
          const m = new THREE.Mesh(orb, glass.material);
          // 進行方向の右（side=1）か左に 2m、目の高さに置く
          m.position.set(p.x + Math.cos(p.yaw) * 2 * side, p.y + 0.3, p.z - Math.sin(p.yaw) * 2 * side);
          root.add(m);
          const id = `${spec.id}/orb-${section}-${n++}`;
          touchables.push({
            id,
            kind: 'hanging-bubble',
            section,
            object: m,
            radius: 0.35,
            enabled: true,
            setHighlight: (v) => glass.setHighlight(v),
            onTouch: (e) => {
              glass.pulse(e.t);
              m.scale.setScalar(1.25);
            },
            idleChime: true,
          });
        }
      }
    },
    update(frame: RoomFrame) {
      for (const h of handles) h.setTime(frame.t);
      for (const t of touchables) t.object.scale.lerp(ONE, Math.min(1, frame.dt * 4));
    },
    onCue(_cue: Cue) {},
    focusPoint(): Vec3Tuple | null {
      if (!ctxRef) return null;
      return null;
    },
    dispose() {
      for (const h of handles) h.dispose();
      for (const g of geometries) g.dispose();
      root.clear();
    },
  };
}
