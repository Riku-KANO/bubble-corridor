// ゴンドラ（泡）。直径約2.4mの透明な球。下半分に真鍮の細い枠と手すり、曇りガラスの座席。
// STUB: 署名は確定。中身は rooms-a 担当が本実装に置き換える。
import * as THREE from 'three/webgpu';
import type { Gondola } from '../contracts/gondola';
import { CAMERA, GONDOLA_DIAMETER } from '../config';
import { createBrass, createGlass } from '../core/materials/glass';

export function createGondola(): Gondola {
  const root = new THREE.Group();
  root.name = 'gondola';
  const r = GONDOLA_DIAMETER / 2;
  // 視界の下側には常にゴンドラの縁が見えるようにする（動かない基準があると VR での酔いが減る）
  const rimGeo = new THREE.TorusGeometry(r * 0.92, 0.025, 8, 64);
  const brass = createBrass();
  const rim = new THREE.Mesh(rimGeo, brass);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = -0.35;
  root.add(rim);
  const shellGeo = new THREE.SphereGeometry(r, 48, 24);
  const shellGlass = createGlass('iridescent', { opacity: 0.08, doubleSided: true });
  const shell = new THREE.Mesh(shellGeo, shellGlass.material);
  shell.renderOrder = 10;
  root.add(shell);
  const seat = new THREE.Object3D();
  seat.name = 'seat';
  seat.position.y = CAMERA.seatEyeHeight;
  root.add(seat);
  return {
    root,
    seat,
    setShell(closed) {
      shell.visible = closed > 0.01;
    },
    update(t) {
      shellGlass.setTime(t);
    },
    dispose() {
      rimGeo.dispose();
      shellGeo.dispose();
      brass.dispose();
      shellGlass.dispose();
    },
  };
}
