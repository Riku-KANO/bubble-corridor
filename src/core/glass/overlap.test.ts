import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { findTransmissionOverlaps, type GlassSilhouette, type ViewSpec } from './overlap';

function viewFrom(position: [number, number, number], target: [number, number, number]): ViewSpec {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 200);
  camera.position.set(...position);
  camera.lookAt(...target);
  camera.updateMatrixWorld();
  return {
    viewMatrix: camera.matrixWorldInverse.elements,
    tanHalfFovY: Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)),
    aspect: camera.aspect,
    near: camera.near,
  };
}

const ball = (id: string, x: number, y: number, z: number, r = 0.4): GlassSilhouette => ({
  id,
  spheres: [{ x, y, z, r }],
});

describe('transmission overlap sensor', () => {
  const view = viewFrom([0, 1.6, 5], [0, 1.6, 0]);

  it('reports glass hidden behind other glass on the sightline, nearer one first', () => {
    const overlaps = findTransmissionOverlaps([ball('back', 0, 1.6, -4), ball('front', 0.1, 1.6, 1)], view);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.front).toBe('front');
    expect(overlaps[0]?.back).toBe('back');
  });

  it('ignores glass side by side on screen', () => {
    expect(findTransmissionOverlaps([ball('left', -1.5, 1.6, 0), ball('right', 1.5, 1.6, 0)], view)).toEqual(
      [],
    );
  });

  it('ignores glass behind the camera or outside the view', () => {
    const objects = [ball('ahead', 0, 1.6, 0), ball('behind', 0, 1.6, 9), ball('far-left', -40, 1.6, 0)];
    expect(findTransmissionOverlaps(objects, view)).toEqual([]);
  });

  it('treats an object made of several bubbles as one silhouette', () => {
    const cluster: GlassSilhouette = {
      id: 'building',
      spheres: [
        { x: -3, y: 1.6, z: -10, r: 1 },
        { x: 0, y: 1.6, z: -10, r: 1.4 },
      ],
    };
    const overlaps = findTransmissionOverlaps([cluster, ball('specimen', -0.9, 1.6, 1, 0.3)], view);
    expect(overlaps.map((o) => [o.front, o.back])).toEqual([['specimen', 'building']]);
  });

  it('finds stacks near the edge of the view, where silhouettes look larger', () => {
    // Seen ~42° and ~47° off-axis; their silhouettes overlap by about 1.6°.
    const objects = [ball('nearer', 4.5, 1.6, 0, 0.4), ball('farther', 10.7, 1.6, -5, 0.8)];
    expect(findTransmissionOverlaps(objects, view).map((o) => [o.front, o.back])).toEqual([
      ['nearer', 'farther'],
    ]);
  });

  it('does not treat a big sphere right beside the camera as covering the whole view', () => {
    const objects = [ball('beside', 2, 1.6, 4, 1.5), ball('ahead', 0, 1.6, -5, 0.3)];
    expect(findTransmissionOverlaps(objects, view)).toEqual([]);
  });

  it('honours a safety margin around silhouettes', () => {
    // Just apart on screen: no overlap without a margin, an overlap with one.
    const objects = [ball('a', -0.45, 1.6, 0, 0.4), ball('b', 0.45, 1.6, -0.1, 0.4)];
    expect(findTransmissionOverlaps(objects, view)).toEqual([]);
    expect(findTransmissionOverlaps(objects, view, { margin: 0.05 })).toHaveLength(1);
  });
});
