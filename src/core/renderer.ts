import * as THREE from 'three/webgpu';

export type Backend = 'webgpu' | 'webgl2';

export interface RendererOptions {
  forceWebGL: boolean;
  renderScale: number;
}

export interface RendererHandle {
  renderer: THREE.WebGPURenderer;
  backend: Backend;
  /** Device pixel ratio before the quality scale (capped at 2). */
  baseDpr: number;
  /** Adapter / renderer string, for logs and the probe. */
  gpuName: string;
  /** True when the backend can read GPU timestamps at all. */
  gpuTiming: boolean;
  /**
   * True when those timestamps may drive decisions. Apple/Metal sums overlapping per-pass times (~10× too high in
   * S-05), so there they are shown but not used until calibrated on the recommended hardware (S-07).
   */
  gpuTimingTrusted: boolean;
}

interface BackendInternals {
  isWebGPUBackend?: boolean;
  hasTimestamp?: boolean;
  trackTimestamp?: boolean;
  device?: { adapterInfo?: { vendor?: string; architecture?: string; description?: string } };
  gl?: WebGL2RenderingContext | null;
}

function describeGpu(b: BackendInternals): string {
  const info = b.device?.adapterInfo;
  if (info) return [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'unknown';
  const gl = b.gl;
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  }
  return 'unknown';
}

/**
 * Creates the single WebGPURenderer for the app (falls back to WebGL2 automatically).
 * Color pipeline follows アートディレクション > 画面の仕上げ: AgX tone mapping, sRGB output.
 * Timestamp queries are requested so quality selection and dynamic resolution can see GPU cost.
 */
export async function createRenderer(container: HTMLElement, opts: RendererOptions): Promise<RendererHandle> {
  const renderer = new THREE.WebGPURenderer({
    antialias: false,
    forceWebGL: opts.forceWebGL,
    trackTimestamp: true,
  });
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const baseDpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(baseDpr * opts.renderScale);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  await renderer.init();
  const b = renderer.backend as BackendInternals;
  const backend: Backend = b.isWebGPUBackend ? 'webgpu' : 'webgl2';
  // Public getter (WebGPU: always; WebGL2: EXT_disjoint_timer_query_webgl2) + the option we passed.
  const gpuTiming = b.hasTimestamp === true && b.trackTimestamp === true;
  const gpuName = describeGpu(b);
  return {
    renderer,
    backend,
    baseDpr,
    gpuName,
    gpuTiming,
    gpuTimingTrusted: gpuTiming && !/apple|metal/i.test(gpuName),
  };
}
