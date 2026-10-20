import * as THREE from 'three/webgpu';
import type { Bubble, FusedBubbleSurface } from './fused-bubbles';

/** three.js wrappers for the pure shape data in fused-bubbles.ts. The caller disposes geometry. */

export function fusedBubbleGeometry(surface: FusedBubbleSurface): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(surface.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(surface.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * A line traced on the fused surface (a meridian at a column, or a ring at a row), lifted `offset`
 * metres along the normal. Blenderアセットパイプライン > 造形: 真鍮の枠はガラスの面からカーブを抽出し、細い管として作る.
 */
export function surfaceLine(
  surface: FusedBubbleSurface,
  line: { column: number } | { row: number },
  offset: number,
): THREE.Vector3[] {
  const { columns, rows, positions, normals } = surface;
  const at = (i: number, j: number): THREE.Vector3 => {
    const k = (i * (columns + 1) + j) * 3;
    return new THREE.Vector3(
      (positions[k] ?? 0) + (normals[k] ?? 0) * offset,
      (positions[k + 1] ?? 0) + (normals[k + 1] ?? 0) * offset,
      (positions[k + 2] ?? 0) + (normals[k + 2] ?? 0) * offset,
    );
  };
  const out: THREE.Vector3[] = [];
  if ('column' in line) for (let i = 0; i <= rows; i++) out.push(at(i, line.column));
  else for (let j = 0; j <= columns; j++) out.push(at(line.row, j));
  return out;
}

/** One instanced mesh for all bubbles inside a piece of bubble glass, in the glass's local space. */
export function innerBubbleMesh(bubbles: readonly Bubble[], material: THREE.Material): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), material, bubbles.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  bubbles.forEach((b, i) => {
    mesh.setMatrixAt(i, m.compose(p.set(b.x, b.y, b.z), q, s.setScalar(b.r)));
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}
