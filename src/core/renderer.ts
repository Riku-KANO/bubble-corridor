import * as THREE from 'three/webgpu';
import { chooseGpuTimeSource, GpuSpanTimer, type GpuTimeSource } from './perf/gpu-span';

export type Backend = 'webgpu' | 'webgl2';

export interface RendererOptions {
  forceWebGL: boolean;
  renderScale: number;
  /** Time the GPU frame span where possible (default true; false for A/B measurements, ?gpuSpan=0). */
  frameSpan?: boolean;
}

export interface RendererHandle {
  renderer: THREE.WebGPURenderer;
  backend: Backend;
  /** Device pixel ratio before the quality scale (capped at 2). */
  baseDpr: number;
  /** Adapter / renderer string, for logs and the probe. */
  gpuName: string;
  /** True when the backend can read three's per-pass GPU timestamps (shown in the overlay and bench). */
  gpuTiming: boolean;
  /**
   * Which GPU time drives decisions: the frame span (WebGPU, our own timestamps, S-08) or three's per-pass sum.
   * See perf/gpu-span.ts.
   */
  gpuSource: GpuTimeSource;
  /**
   * True when GPU time may drive decisions. The frame span is trusted everywhere; the per-pass sum is not on
   * Apple/Metal, where overlapping passes read ~10× too high (S-05).
   */
  gpuTimingTrusted: boolean;
  /** The WebGPU device when the frame span can be timed on it (for GpuSpanTimer), otherwise null. */
  spanDevice: GPUDevice | null;
}

interface BackendInternals {
  isWebGPUBackend?: boolean;
  hasTimestamp?: boolean;
  trackTimestamp?: boolean;
  device?: GPUDevice;
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
 * Timestamp queries are requested so quality selection and dynamic resolution can see GPU cost
 * (three's per-pass sum for reference, the frame span from perf/gpu-span.ts for decisions).
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
  const spanDevice =
    opts.frameSpan !== false && backend === 'webgpu' && GpuSpanTimer.supported(b.device) ? b.device : null;
  const { source, trusted } = chooseGpuTimeSource({
    span: spanDevice !== null,
    passes: gpuTiming,
    apple: /apple|metal/i.test(gpuName),
  });
  return {
    renderer,
    backend,
    baseDpr,
    gpuName,
    gpuTiming,
    gpuSource: source,
    gpuTimingTrusted: trusted,
    spanDevice,
  };
}
