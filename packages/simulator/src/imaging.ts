// Deterministic synthetic imaging. Renders the frozen world state into RGBA
// buffers (wells as circles with fill level / medium colour / turbidity;
// culture_detail draws schematic organoid blobs seeded by well+morphology),
// encodes PNGs with fixed parameters. No text, no fonts. Inputs are quantized
// (volume 1 µL, colour 1/255) so equal states -> equal bytes.
//
// Blur (box blur of the rendered pixels) happens when the plate is shaking,
// within shake settle_s after a shake ended, or while a scenario camera_blur
// fault still has scans left. Blurred observations get quality='blurred' and
// NULL estimate values — values are never invented.
import {createHash} from 'node:crypto';
import {DEMO_PROFILE, type WellEstimate} from '@oscar/device-contract';
import {encodePng} from './png.ts';
import {normal, uniform} from './rand.ts';
import {findPlate, type PlateSim, type World} from './world.ts';

export type ScanMode = 'mono' | 'stereo';
export type ScanView = 'medium_overview' | 'culture_detail';

export interface ScanRequest {
  plate_id: string;
  wells: string[];
  mode: ScanMode;
  view: ScanView;
}

export interface RenderedImage {role: 'mono' | 'left' | 'right'; bytes: Uint8Array; width: number; height: number; sha256: string}

export interface ScanResult {
  sampled_at_sim_s: number;
  plate_revision: number;
  quality: 'ok' | 'blurred';
  blurred: boolean;
  stereo_pair_id: string | null;
  images: RenderedImage[];
  estimates: WellEstimate[];
  camera: Record<string, unknown>;
}

const W = DEMO_PROFILE.imaging.image_px.width;
const H = DEMO_PROFILE.imaging.image_px.height;
const COLS = 6, ROWS = 4;                     // 24-well display plate
const SX = 44, SY = 40;                       // well pitch (px)
const X0 = Math.floor((W - COLS * SX) / 2 + SX / 2);
const Y0 = Math.floor((H - ROWS * SY) / 2 + SY / 2);
const R = 16;                                  // well radius (px)
const BG = [22, 24, 28] as const;
const PLATE = [52, 50, 46] as const;

/** Deterministic RGBA canvas. */
class Canvas {
  readonly px: Uint8Array;
  constructor() {
    this.px = new Uint8Array(W * H * 4);
    this.fillRect(0, 0, W, H, BG, 255);
  }
  set(x: number, y: number, rgb: readonly number[], alpha: number): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    const a = Math.min(255, Math.max(0, alpha)) / 255;
    // Fixed blend order.
    this.px[i] = Math.round(this.px[i] * (1 - a) + rgb[0] * a);
    this.px[i + 1] = Math.round(this.px[i + 1] * (1 - a) + rgb[1] * a);
    this.px[i + 2] = Math.round(this.px[i + 2] * (1 - a) + rgb[2] * a);
    this.px[i + 3] = Math.round(Math.max(this.px[i + 3] * (1 - a), a * 255));
  }
  fillRect(x0: number, y0: number, x1: number, y1: number, rgb: readonly number[], alpha: number): void {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) this.set(x, y, rgb, alpha);
  }
  ring(cx: number, cy: number, r: number, rgb: readonly number[], alpha: number, thickness = 1): void {
    for (let y = cy - r - thickness; y <= cy + r + thickness; y++) for (let x = cx - r - thickness; x <= cx + r + thickness; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d <= r + thickness && d >= r) this.set(x, y, rgb, alpha);
    }
  }
}

/** Quantize a volume to 1 µL for drawing. */
const qVolume = (v: number): number => Math.round(v);
/** Quantize a 0–1 index to 1/255 steps. */
const q255 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255) / 255;

/** Medium colour: fresh = phenol-red pink, depleted = yellowish (demo palette). */
function mediumColour(nutrientQ: number): [number, number, number] {
  const n = nutrientQ;
  // lerp(yellow, red, n)
  return [Math.round(196 + (224 - 196) * n), Math.round(186 + (84 - 186) * n), Math.round(70 + (84 - 70) * n)];
}

function drawWell(c: Canvas, cx: number, cy: number, r: number, volumeUl: number, capacityUl: number,
  nutrient: number, turbidity: number, scanned: boolean, detail: boolean, seed: number, wellId: string): void {
  // Well cavity
  c.ring(cx, cy, r, [12, 12, 14], 255, 1);
  // Liquid fill from the bottom of the well.
  const vq = qVolume(volumeUl);
  const frac = capacityUl > 0 ? Math.min(1, Math.max(0, vq / capacityUl)) : 0;
  if (vq > 0 && frac > 0.01) {
    const surfaceY = cy + r - Math.round(2 * r * frac);
    const rgb = mediumColour(nutrient);
    for (let y = Math.max(cy - r, surfaceY); y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) c.set(x, y, rgb, 235);
      }
    }
    // Turbidity: deterministic light-scattering speckle over the liquid.
    if (turbidity > 0.02) {
      const alpha = Math.round(q255(turbidity) * 150);
      for (let y = Math.max(cy - r, surfaceY); y <= cy + r; y += 2) {
        for (let x = cx - r; x <= cx + r; x += 2) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
          const u = uniform(seed, `speck:${wellId}`, x * 131 + y, 0);
          if (u < turbidity) c.set(x, y, [240, 238, 230], alpha);
        }
      }
    }
  }
  if (detail) drawOrganoids(c, cx, cy, r, seed, wellId, nutrient);
  if (scanned) c.ring(cx, cy, r + 2, [235, 235, 245], 130, 1);
}

/** Schematic organoid blobs (culture_detail view): count/size seeded by well + morphology. */
function drawOrganoids(c: Canvas, cx: number, cy: number, r: number, seed: number, wellId: string, morphology: number): void {
  const m = q255(morphology);
  const count = 1 + Math.round(m * 6);
  for (let i = 0; i < count; i++) {
    const urx = uniform(seed, `blob:${wellId}`, i, 1);
    const ury = uniform(seed, `blob:${wellId}`, i, 2);
    const urr = uniform(seed, `blob:${wellId}`, i, 3);
    const bx = cx + Math.round((urx * 2 - 1) * (r - 5));
    const by = cy + Math.round((ury * 2 - 1) * (r - 5));
    const br = 2 + Math.round(urr * (2 + m * 4));
    const shade = 170 + Math.round(uniform(seed, `blob:${wellId}`, i, 4) * 60);
    for (let y = by - br; y <= by + br; y++) for (let x = bx - br; x <= bx + br; x++) {
      if ((x - bx) ** 2 + (y - by) ** 2 <= br * br && (x - cx) ** 2 + (y - cy) ** 2 <= (r - 1) ** 2) {
        c.set(x, y, [shade, Math.round(shade * 0.96), Math.round(shade * 0.9)], 165);
      }
    }
  }
}

/** Box blur (radius r) of the whole buffer, in place on a copy. Deterministic. */
function boxBlur(px: Uint8Array, r: number): Uint8Array {
  const src = new Uint8Array(px);
  const tmp = new Uint8Array(px.length);
  // Horizontal pass into tmp, vertical pass into out.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, n = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(W - 1, Math.max(0, x + dx));
        const i = (y * W + xx) * 4;
        s0 += src[i]; s1 += src[i + 1]; s2 += src[i + 2]; s3 += src[i + 3]; n++;
      }
      const o = (y * W + x) * 4;
      tmp[o] = Math.round(s0 / n); tmp[o + 1] = Math.round(s1 / n); tmp[o + 2] = Math.round(s2 / n); tmp[o + 3] = Math.round(s3 / n);
    }
  }
  const out = new Uint8Array(px.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(H - 1, Math.max(0, y + dy));
        const i = (yy * W + x) * 4;
        s0 += tmp[i]; s1 += tmp[i + 1]; s2 += tmp[i + 2]; s3 += tmp[i + 3]; n++;
      }
      const o = (y * W + x) * 4;
      out[o] = Math.round(s0 / n); out[o + 1] = Math.round(s1 / n); out[o + 2] = Math.round(s2 / n); out[o + 3] = Math.round(s3 / n);
    }
  }
  return out;
}

function render(world: World, plate: PlateSim, req: ScanRequest, offsetX: number): Uint8Array {
  const c = new Canvas();
  const detail = req.view === 'culture_detail';
  // Plate deck.
  const px0 = X0 - SX / 2, py0 = Y0 - SY / 2;
  c.fillRect(Math.floor(px0) - 6, Math.floor(py0) - 6, Math.ceil(px0 + (COLS - 1) * SX + SX / 2) + 6,
    Math.ceil(py0 + (ROWS - 1) * SY + SY / 2) + 6, detail ? [30, 34, 40] : PLATE, 255);
  const scanned = new Set(req.wells);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const wellId = `${String.fromCharCode(65 + row)}${col + 1}`;
      const well = plate.wells.find(w => w.well_id === wellId);
      if (!well) continue;
      const turbidity = Math.min(1, well.culture.metabolite * 0.6 + well.culture.mixing * 0.3 + well.culture.morphology * 0.4);
      drawWell(c, X0 + col * SX + offsetX, Y0 + row * SY, R, well.volume_ul, well.capacity_ul,
        well.culture.nutrient, turbidity, scanned.has(wellId), detail, world.seed, wellId);
    }
  }
  return c.px;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function image(px: Uint8Array, role: RenderedImage['role']): RenderedImage {
  const bytes = encodePng(W, H, px);
  return {role, bytes, width: W, height: H, sha256: sha256(bytes)};
}

/** True when this scan must come out blurred (shake / settle window / fault). */
function blurReason(world: World, plate: PlateSim): 'shake' | 'settle' | 'fault' | null {
  if (plate.shake.active) return 'shake';
  if (plate.shake.ended_at_sim_s != null && world.sim_time_s < plate.shake.settle_until_sim_s) return 'settle';
  if (world.faults.camera_blur.remaining_scans > 0) return 'fault';
  return null;
}

/** Perform a scan against the FROZEN world (this step's world state). Mutates only counters/faults. */
export function performScan(world: World, req: ScanRequest): ScanResult {
  const plate = findPlate(world, req.plate_id);
  if (!plate) throw new Error(`unknown plate ${req.plate_id}`);
  const reason = blurReason(world, plate);
  const blurred = reason != null;
  if (reason === 'fault') world.faults.camera_blur.remaining_scans -= 1;
  const scanIndex = world.counters.scan_count;
  world.counters.scan_count += 1;

  const parallax = detailParallaxPx();
  const rawPx: {role: RenderedImage['role']; px: Uint8Array}[] = [];
  if (req.mode === 'stereo') {
    rawPx.push({role: 'left', px: render(world, plate, req, -parallax)});
    rawPx.push({role: 'right', px: render(world, plate, req, parallax)});
  } else {
    rawPx.push({role: 'mono', px: render(world, plate, req, 0)});
  }
  const images = rawPx.map(({role, px}) => image(blurred ? boxBlur(px, 4) : px, role));
  const estimates = req.wells.map((wellId, i) => estimateWell(world, plate, wellId, blurred, scanIndex, i));

  return {
    sampled_at_sim_s: world.sim_time_s,
    plate_revision: plate.revision,
    quality: blurred ? 'blurred' : 'ok',
    blurred,
    stereo_pair_id: req.mode === 'stereo' ? `stereo-${scanIndex}` : null,
    images,
    estimates,
    camera: {
      mount: 'head_z_axis', simulated: true,
      mode: req.mode, view: req.view,
      image_px: {width: W, height: H},
      ...(req.mode === 'stereo' ? {baseline_mm: DEMO_PROFILE.imaging.stereo_baseline_mm, parallax_px: parallax} : {}),
    },
  };
}

const detailParallaxPx = (): number => 6;

function estimateWell(world: World, plate: PlateSim, wellId: string, blurred: boolean,
  scanIndex: number, wellOrdinal: number): WellEstimate {
  const well = plate.wells.find(w => w.well_id === wellId)!;
  const t = world.sim_time_s;
  const uncertainty = Math.max(5, Math.round(well.volume_ul * 0.02));
  if (blurred) {
    return {well_id: wellId, liquid_level_ul: null, color_index: null, turbidity: null,
      quality: 0.25, provenance: 'device_estimate', method: 'simulated_onboard_analysis', uncertainty_ul: uncertainty};
  }
  const ch = (tag: string): string => `estimate:${wellId}:${tag}`;
  const level = Math.max(0, well.volume_ul + normal(world.seed, ch('level'), t, scanIndex) * uncertainty * 0.35);
  const colorIdx = Math.min(1, Math.max(0, well.culture.nutrient + normal(world.seed, ch('color'), t, scanIndex) * 0.02));
  const turbidity = Math.min(1, Math.max(0, well.culture.metabolite * 0.6 + well.culture.mixing * 0.3
    + well.culture.morphology * 0.4 + normal(world.seed, ch('turb'), t, scanIndex) * 0.02));
  return {
    well_id: wellId,
    liquid_level_ul: Math.round(level * 100) / 100,
    color_index: Math.round(q255(colorIdx) * 1000) / 1000,
    turbidity: Math.round(q255(turbidity) * 1000) / 1000,
    quality: Math.round((0.97 + uniform(world.seed, ch('q'), t, wellOrdinal) * 0.03) * 1000) / 1000,
    provenance: 'device_estimate', method: 'simulated_onboard_analysis', uncertainty_ul: uncertainty,
  };
}
