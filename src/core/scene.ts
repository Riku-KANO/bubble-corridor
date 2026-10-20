import type * as THREE from 'three/webgpu';
import type { QualityLevel, QualityPreset } from './quality';
import type { Backend } from './renderer';

/**
 * Everything a sandbox scene receives from the app shell.
 * Scenes must not create their own renderer or animation loop.
 */
export interface SceneContext {
  renderer: THREE.WebGPURenderer;
  backend: Backend;
  canvas: HTMLCanvasElement;
  /** DOM layer above the canvas for scene-specific UI. Cleared on dispose. */
  overlay: HTMLElement;
  quality: QualityPreset;
  qualityLevel: QualityLevel;
  /** Raw URL params so a scene can read its own debug switches. */
  params: URLSearchParams;
}

export interface SandboxScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Called once per frame before render. dt and t are in seconds. */
  update(dt: number, t: number): void;
  /**
   * Optional custom render (multi-pass, post-processing).
   * Default: renderer.render(scene, camera).
   */
  render?(): void;
  /** Called after the canvas size changes. Camera aspect is already updated. */
  resize?(width: number, height: number): void;
  dispose(): void;
}

export type SceneFactory = (ctx: SceneContext) => Promise<SandboxScene>;

export interface SceneModule {
  /** One line shown in the scene list. */
  title: string;
  default: SceneFactory;
}
