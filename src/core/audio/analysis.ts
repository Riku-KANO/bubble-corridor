/**
 * Offline measurements on rendered audio (pure functions, no Web Audio).
 * Used by the browser sensor (tests/e2e) and unit tests to check level, pitch and decay
 * numerically, since an agent cannot listen. Also useful later for checking recorded glass samples.
 */

type Samples = ArrayLike<number>;

export function rms(x: Samples, start = 0, end = x.length): number {
  const a = Math.max(0, start);
  const b = Math.min(x.length, end);
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) {
    const v = x[i] as number;
    sum += v * v;
  }
  return Math.sqrt(sum / (b - a));
}

export function peak(x: Samples, start = 0, end = x.length): number {
  let m = 0;
  for (let i = Math.max(0, start); i < Math.min(x.length, end); i++)
    m = Math.max(m, Math.abs(x[i] as number));
  return m;
}

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const br = re[b] as number;
        const bi = im[b] as number;
        const xr = br * cr - bi * ci;
        const xi = br * ci + bi * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

interface Spectrum {
  mag: Float64Array;
  binHz: number;
}

/** Hann-windowed, zero-padded magnitude spectrum of x[start, start + length). */
function magnitudeSpectrum(
  x: Samples,
  sampleRate: number,
  start: number,
  length: number,
  minSize: number,
): Spectrum {
  const size = Math.min(1 << 18, nextPow2(Math.max(minSize, length * 4)));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, length - 1));
    re[i] = ((x[start + i] as number) ?? 0) * w;
  }
  fft(re, im);
  const mag = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k] as number, im[k] as number);
  return { mag, binHz: sampleRate / size };
}

function segment(x: Samples, sampleRate: number, startSec: number, durationSec?: number): [number, number] {
  const a = Math.max(0, Math.round(startSec * sampleRate));
  const maxLen = Math.max(0, x.length - a);
  const len = durationSec === undefined ? Math.min(maxLen, sampleRate) : Math.round(durationSec * sampleRate);
  return [a, Math.max(0, Math.min(maxLen, len))];
}

export interface PitchOptions {
  /** Seconds from the start of x. */
  start?: number;
  /** Seconds to analyse (default: the rest of x, at most 1 s). */
  duration?: number;
  minHz?: number;
  maxHz?: number;
  /** A peak counts as the fundamental if it reaches this fraction of the strongest peak. */
  threshold?: number;
}

/**
 * Fundamental frequency estimate for pitched (also inharmonic) sounds: the lowest spectral peak
 * that reaches `threshold` of the strongest one, refined by Gaussian (log-parabolic) interpolation.
 * Returns null for silence. Autocorrelation is avoided on purpose: glass overtones are not harmonic.
 * Caveat (e.g. for recorded samples): if the fundamental is weaker than `threshold` × the strongest
 * peak, this returns an overtone. For such sounds lower `threshold`, or check for peaks at f/2, f/3.
 * Our synthesized voices keep the fundamental the strongest partial, so the default is safe for them.
 */
export function estimatePitch(x: Samples, sampleRate: number, opts: PitchOptions = {}): number | null {
  const [start, length] = segment(x, sampleRate, opts.start ?? 0, opts.duration);
  if (length < 64 || rms(x, start, start + length) < 1e-5) return null;
  const { mag, binHz } = magnitudeSpectrum(x, sampleRate, start, length, 16384);
  const lo = Math.max(1, Math.floor((opts.minHz ?? 40) / binHz));
  const hi = Math.min(mag.length - 2, Math.ceil((opts.maxHz ?? 8000) / binHz));
  let max = 0;
  for (let k = lo; k <= hi; k++) max = Math.max(max, mag[k] as number);
  if (max <= 0) return null;
  const floor = max * (opts.threshold ?? 0.25);
  for (let k = lo; k <= hi; k++) {
    const m = mag[k] as number;
    if (m >= floor && m >= (mag[k - 1] as number) && m > (mag[k + 1] as number)) {
      const la = Math.log((mag[k - 1] as number) + 1e-12);
      const lb = Math.log(m + 1e-12);
      const lc = Math.log((mag[k + 1] as number) + 1e-12);
      const denom = la - 2 * lb + lc;
      const p = denom === 0 ? 0 : (0.5 * (la - lc)) / denom;
      return (k + p) * binHz;
    }
  }
  return null;
}

export interface DecayOptions {
  /** Level (dB below the start of the Schroeder curve) where the fit begins. */
  fromDb?: number;
  /** Level where the fit ends. */
  toDb?: number;
}

/**
 * Reverberation / ring-out time T60 from Schroeder backward integration: fit a line to the energy
 * decay curve between fromDb and toDb (default -5 … -35 dB, i.e. T30) and extrapolate to -60 dB.
 * Returns null if the signal never decays far enough.
 */
export function decayT60(x: Samples, sampleRate: number, opts: DecayOptions = {}): number | null {
  const fromDb = opts.fromDb ?? -5;
  const toDb = opts.toDb ?? -35;
  const n = x.length;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    const v = x[i] as number;
    acc += v * v;
    edc[i] = acc;
  }
  const total = edc[0] as number;
  if (!(total > 0)) return null;
  let i1 = -1;
  let i2 = -1;
  for (let i = 0; i < n; i++) {
    const db = 10 * Math.log10((edc[i] as number) / total + 1e-300);
    if (i1 < 0 && db <= fromDb) i1 = i;
    if (db <= toDb) {
      i2 = i;
      break;
    }
  }
  if (i1 < 0 || i2 <= i1 + 1) return null;
  // Least-squares slope of dB over time on [i1, i2], subsampled for speed.
  const step = Math.max(1, Math.floor((i2 - i1) / 2000));
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let count = 0;
  for (let i = i1; i <= i2; i += step) {
    const t = i / sampleRate;
    const db = 10 * Math.log10((edc[i] as number) / total + 1e-300);
    sx += t;
    sy += db;
    sxx += t * t;
    sxy += t * db;
    count++;
  }
  const slope = (count * sxy - sx * sy) / (count * sxx - sx * sx);
  return slope < 0 ? -60 / slope : null;
}

/** Spectral centroid (Hz) of a window; a simple "brightness" measure. */
export function spectralCentroid(
  x: Samples,
  sampleRate: number,
  startSec: number,
  durationSec: number,
): number {
  const [start, length] = segment(x, sampleRate, startSec, durationSec);
  if (length < 64) return 0;
  const { mag, binHz } = magnitudeSpectrum(x, sampleRate, start, length, 1024);
  let num = 0;
  let den = 0;
  for (let k = 1; k < mag.length; k++) {
    const m = mag[k] as number;
    num += k * binHz * m;
    den += m;
  }
  return den > 0 ? num / den : 0;
}

/** Pearson correlation over the common length. */
export function correlation(a: Samples, b: Samples): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
