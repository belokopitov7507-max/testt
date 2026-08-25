// ============================================================================
// Конвейер удаления водяного знака. Всё локально, в браузере.
//
//  1) маска = ВСЯ выделенная пользователем область (прямоугольник + кисть),
//     расширенная на 2 px (перехват антиалиасинга и гало знака);
//  2) покадровый проход: seek → кадр → восстановление области с фиксированным
//     бюджетом операций (полное разрешение, без даунскейла);
//  3) кодирование WebCodecs (H.264 → MP4 / VP9 → WebM) с точными
//     таймстампами i/fps — без пропусков кадров;
//  4) оригинальный звук: декодируется из файла, приводится к 48 кГц,
//     кодируется AAC (или Opus + WebM); если аудиокодеров нет — путь
//     MediaRecorder, который кодирует звук сам;
//  5) запасной путь для браузеров без WebCodecs — MediaRecorder в реальном
//     времени с жёстким бюджетом инпейнтинга (кадры не пропускаются).
// ============================================================================
import { createInpainter, type RemovalMode } from "./inpaint";
// @ts-ignore — типы могут отсутствовать
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
// @ts-ignore
import { Muxer as WebMMuxer, ArrayBufferTarget as WebMArrayBufferTarget } from "webm-muxer";

export type { RemovalMode };

export interface Settings {
  /** smart = «Подбор фона» (Telea), dissolve = «Растворение» */
  mode: RemovalMode;
  radius: number;
  track: boolean;
}

export interface Progress {
  pct: number;
  t: number;
  duration: number;
  frames: number;
  fps: number;
}

export type AudioStatus = "aac" | "opus" | "live" | "silent" | "none";

export interface ProcessResult {
  blob: Blob;
  ext: "mp4" | "webm";
  mime: string;
  frames: number;
  audio: AudioStatus;
}

export interface ProcessOptions {
  video: HTMLVideoElement;
  sourceBlob: Blob;
  outCanvasRef: { current: HTMLCanvasElement | null };
  maskCanvas: HTMLCanvasElement;
  settings: Settings;
  cancelled: { current: boolean };
  onStage: (s: string) => void;
  onProgress: (p: Progress) => void;
}

// ---------------------------- вспомогательное ----------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(video.currentTime - t) < 0.001) return;
  await new Promise<void>((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
    setTimeout(() => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    }, 1500);
  });
}

/** Дождаться, пока кадр реально декодирован и представлен. */
function awaitFrame(video: HTMLVideoElement): Promise<void> {
  const anyV = video as any;
  if (typeof anyV.requestVideoFrameCallback === "function") {
    return new Promise<void>((res) => {
      const to = setTimeout(() => res(), 150);
      anyV.requestVideoFrameCallback(() => {
        clearTimeout(to);
        res();
      });
    });
  }
  return (async () => {
    let waited = 0;
    while (video.readyState < 2 && waited < 1000) {
      await sleep(40);
      waited += 40;
    }
  })();
}

function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const list = [
    "video/mp4;codecs=avc1.640033,mp4a.40.2",
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const m of list) if (MediaRecorder.isTypeSupported(m)) return m;
  return null;
}

function hasWebCodecs(): boolean {
  return (
    typeof g.VideoEncoder !== "undefined" &&
    typeof g.VideoFrame !== "undefined"
  );
  // Аудиокодеры НЕ обязательны: при их отсутствии сработает гибридный путь
  // (офлайн-кадры + запись оригинального звука в реальном времени).
}

// ---------------------------- маска ----------------------------

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function maskBBox(mask: HTMLCanvasElement, pad: number): BBox | null {
  const W = mask.width;
  const H = mask.height;
  const data = mask.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (data[(row + x) * 4 + 3] > 120) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    x: Math.max(0, minX - pad),
    y: Math.max(0, minY - pad),
    w: Math.min(W, maxX + pad + 1) - Math.max(0, minX - pad),
    h: Math.min(H, maxY + pad + 1) - Math.max(0, minY - pad),
  };
}

/**
 * Расширить маску на 1 px за проход (4 направления). Перехватывает
 * антиалиасинг и полупрозрачное гало по краю выделения пользователя.
 */
function dilateCanvas(src: HTMLCanvasElement, passes: number): HTMLCanvasElement {
  let c = src;
  for (let p = 0; p < passes; p++) {
    const nx = document.createElement("canvas");
    nx.width = c.width;
    nx.height = c.height;
    const nctx = nx.getContext("2d")!;
    nctx.drawImage(c, 0, 0);
    nctx.drawImage(c, 1, 0);
    nctx.drawImage(c, -1, 0);
    nctx.drawImage(c, 0, 1);
    nctx.drawImage(c, 0, -1);
    c = nx;
  }
  return c;
}

// ---------------------------- авто-детекция пикселей знака ----------------------------
//
// Восстанавливать ВЕСЬ прямоугольник пользователя нельзя: чистый фон внутри
// выделения заменяется интерполяцией и выглядит как плоская цветная заплатка.
// Поэтому внутри выделения мы находим пиксели самого знака:
//   1) края = |I − blur(I)| > адаптивный порог (контур текста/логотипа);
//   2) заливка: всё, что НЕ достижимо от границы ROI по не-краям, —
//      внутренность знаков (буквы целиком, а не только контур);
//   3) фильтрация компонент по размеру и плотности краёв (отсекает облака/шум);
//   4) расширение на 3px + «неуверенная полоса» (полупрозрачное гало знака);
//   5) ЖЁСТКОЕ ограничение маской пользователя (выделение + 2px) — наружу
//      ничего не вылезает.
// Если знак не найден (< 16 px) — удаляется вся выделенная область целиком.

function blurLum(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const k = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / k;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / k;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function dilateU8(src: Uint8Array, w: number, h: number, iters: number): Uint8Array {
  let a: Uint8Array = src;
  let b: Uint8Array = new Uint8Array(src.length);
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        let v = a[i];
        if (!v) {
          if (x > 0 && a[i - 1]) v = 1;
          else if (x < w - 1 && a[i + 1]) v = 1;
          else if (y > 0 && a[i - w]) v = 1;
          else if (y < h - 1 && a[i + w]) v = 1;
        }
        b[i] = v;
      }
    }
    const t = a;
    a = b;
    b = t;
  }
  return a;
}

function clampBBox(bb: BBox, W: number, H: number): BBox {
  const x = Math.max(1, Math.min(bb.x, W - 3));
  const y = Math.max(1, Math.min(bb.y, H - 3));
  return {
    x,
    y,
    w: Math.max(2, Math.min(bb.w, W - 1 - x)),
    h: Math.max(2, Math.min(bb.h, H - 1 - y)),
  };
}

/**
 * Найти пиксели знака в кадре (fctx — уже нарисованный полный кадр).
 * Возвращает полноразмерную маску, ограниченную userBox+2px, либо null.
 */
function detectTightMaskFromFrame(
  fctx: CanvasRenderingContext2D,
  workBox: BBox,
  userBox: BBox,
  W: number,
  H: number,
): HTMLCanvasElement | null {
  const bw = workBox.w;
  const bh = workBox.h;
  if (bw < 12 || bh < 12) return null;
  const roi = fctx.getImageData(workBox.x, workBox.y, bw, bh);
  const n = bw * bh;

  const lum = new Float32Array(n);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    lum[i] = roi.data[q] * 0.299 + roi.data[q + 1] * 0.587 + roi.data[q + 2] * 0.114;
  }
  const blurR = Math.min(8, Math.max(2, Math.round(Math.min(bw, bh) / 16)));
  const blurred = blurLum(blurLum(lum, bw, bh, blurR), bw, bh, blurR);

  const diff = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    diff[i] = Math.abs(lum[i] - blurred[i]);
    mean += diff[i];
  }
  mean /= n;
  let std = 0;
  for (let i = 0; i < n; i++) {
    const d = diff[i] - mean;
    std += d * d;
  }
  std = Math.sqrt(std / n);
  const T = Math.max(10, Math.min(60, mean + 3.2 * std));

  const edges = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (diff[i] > T) edges[i] = 1;
  }
  const edgesD = dilateU8(edges, bw, bh, 2);

  // заливка снаружи: flood-fill от границы ROI по не-краям (4-связность)
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const pushIf = (i: number) => {
    if (!edgesD[i] && !outside[i]) {
      outside[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < bw; x++) {
    pushIf(x);
    pushIf((bh - 1) * bw + x);
  }
  for (let y = 0; y < bh; y++) {
    pushIf(y * bw);
    pushIf(y * bw + bw - 1);
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % bw;
    const y = (i - x) / bw;
    if (x > 0) pushIf(i - 1);
    if (x < bw - 1) pushIf(i + 1);
    if (y > 0) pushIf(i - bw);
    if (y < bh - 1) pushIf(i + bw);
  }

  // компоненты связности внутренностей (8-связность)
  const labels = new Int32Array(n);
  const compSize: number[] = [0];
  const compEdge: number[] = [0];
  let nComps = 0;
  for (let i = 0; i < n; i++) {
    if (outside[i] || labels[i]) continue;
    nComps++;
    labels[i] = nComps;
    stack[0] = i;
    sp = 1;
    let size = 0;
    let ec = 0;
    while (sp > 0) {
      const j = stack[--sp];
      size++;
      if (edges[j]) ec++;
      const x = j % bw;
      const y = (j - x) / bw;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= bw) continue;
          const kk = yy * bw + xx;
          if (!outside[kk] && !labels[kk]) {
            labels[kk] = nComps;
            stack[sp++] = kk;
          }
        }
      }
    }
    compSize.push(size);
    compEdge.push(ec);
  }

  const kept = new Uint8Array(n);
  let keptCount = 0;
  for (let i = 0; i < n; i++) {
    if (outside[i]) continue;
    const c = labels[i];
    const ok = compSize[c] >= 10 && compSize[c] <= 0.65 * n && compEdge[c] >= Math.max(6, compSize[c] * 0.02);
    if (ok) {
      kept[i] = 1;
      keptCount++;
    }
  }
  if (keptCount < 16 || keptCount > 0.7 * n) return null;

  // расширение + неуверенная полоса (полупрозрачное гало и антиалиасинг знака)
  let mask = dilateU8(kept, bw, bh, 3);
  const band = dilateU8(kept, bw, bh, 8);
  const T2 = Math.max(6, T * 0.45);
  for (let i = 0; i < n; i++) {
    if (band[i] && !mask[i] && diff[i] > T2) mask[i] = 1;
  }

  // перенос в полноразмерную маску с жёстким ограничением userBox + 2px
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const mctx = canvas.getContext("2d")!;
  const id = mctx.createImageData(W, H);
  const x0 = userBox.x - 2;
  const y0 = userBox.y - 2;
  const x1 = userBox.x + userBox.w + 2;
  const y1 = userBox.y + userBox.h + 2;
  let written = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (!mask[y * bw + x]) continue;
      const vx = workBox.x + x;
      const vy = workBox.y + y;
      if (vx < x0 || vx >= x1 || vy < y0 || vy >= y1) continue; // не вылезать за выделение
      const q = (vy * W + vx) * 4;
      id.data[q] = 255;
      id.data[q + 1] = 255;
      id.data[q + 2] = 255;
      id.data[q + 3] = 255;
      written++;
    }
  }
  if (written < 16) return null;
  mctx.putImageData(id, 0, 0);
  return canvas;
}

/**
 * Построить эффективную маску для обработки:
 *  — пиксели знака, найденные внутри выделения (приоритет), либо
 *  — вся выделенная область целиком, если знак не обнаружен.
 */
export async function buildEffectiveMask(
  video: HTMLVideoElement,
  maskCanvas: HTMLCanvasElement,
  radius: number,
): Promise<{ mask: HTMLCanvasElement; bbox: BBox } | null> {
  const W = video.videoWidth;
  const H = video.videoHeight;
  const userBox = maskBBox(maskCanvas, 0);
  if (!userBox) return null;
  const pad = Math.min(48, radius * 2 + 8);
  const workBoxRaw = maskBBox(maskCanvas, pad);
  if (!workBoxRaw) return null;
  const workBox = clampBBox(workBoxRaw, W, H);

  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  await seekTo(video, Math.min(0.15, Math.max(0.02, (video.duration || 1) * 0.05)));
  await awaitFrame(video);
  ctx.drawImage(video, 0, 0, W, H);

  let tight: HTMLCanvasElement | null = null;
  try {
    tight = detectTightMaskFromFrame(ctx, workBox, userBox, W, H);
  } catch (e) {
    console.warn("Авто-детекция знака не удалась — используется вся область:", e);
  }
  if (!tight) {
    return { mask: dilateCanvas(maskCanvas, 2), bbox: workBox };
  }
  const tb = maskBBox(tight, pad);
  return { mask: tight, bbox: tb ? clampBBox(tb, W, H) : workBox };
}

// ---------------------------- FPS источника ----------------------------

const STD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

/** Точный FPS по requestVideoFrameCallback + «прищёлкивание» к стандартным. */
async function measureFps(video: HTMLVideoElement, cancelled: { current: boolean }): Promise<number> {
  const anyV = video as any;
  if (typeof anyV.requestVideoFrameCallback !== "function") return 30;

  const times: number[] = [];
  await seekTo(video, 0);
  try {
    await video.play();
  } catch {
    return 30;
  }
  video.muted = true; // звук на время замера не нужен

  const done = new Promise<void>((resolve) => {
    const start = performance.now();
    const cb = (_: number, meta: { mediaTime?: number }) => {
      if (cancelled.current || performance.now() - start > 1100) {
        resolve();
        return;
      }
      if (typeof meta.mediaTime === "number") times.push(meta.mediaTime);
      anyV.requestVideoFrameCallback(cb);
    };
    anyV.requestVideoFrameCallback(cb);
    setTimeout(resolve, 1300);
  });
  await done;
  video.pause();
  video.muted = false;

  if (times.length < 4) return 30;
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0.0005 && d < 0.5) diffs.push(d);
  }
  if (diffs.length < 3) return 30;
  diffs.sort((a, b) => a - b);
  const med = diffs[Math.floor(diffs.length / 2)];
  const raw = 1 / med;
  let best = raw;
  let bestErr = Infinity;
  for (const s of STD_FPS) {
    const err = Math.abs(raw - s);
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return bestErr < 1.5 ? best : Math.round(raw * 100) / 100;
}

// ---------------------------- отслеживание движения ----------------------------

/** Сигнатура области: усреднённая сетка яркости. */
function regionSignature(video: HTMLVideoElement, octx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, G = 8): Float32Array {
  const cw = Math.max(8, Math.floor(w / G));
  const ch = Math.max(8, Math.floor(h / G));
  const tmp = document.createElement("canvas");
  tmp.width = cw;
  tmp.height = ch;
  const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(video, x, y, w, h, 0, 0, cw, ch);
  const d = tctx.getImageData(0, 0, cw, ch).data;
  const sig = new Float32Array(G * G);
  const cellX = cw / G;
  const cellY = ch / G;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      let s = 0;
      let cnt = 0;
      const x0 = Math.floor(gx * cellX);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cellX));
      const y0 = Math.floor(gy * cellY);
      const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cellY));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const q = (yy * cw + xx) << 2;
          s += d[q] * 0.299 + d[q + 1] * 0.587 + d[q + 2] * 0.114;
          cnt++;
        }
      }
      sig[gy * G + gx] = cnt > 0 ? s / cnt : 0;
    }
  }
  return sig;
}

/** Сместить сигнатуру на (dx, dy) ячеек (вне диапазона — ноль). */
function shiftSig(sig: Float32Array, dx: number, dy: number, G: number): Float32Array {
  const out = new Float32Array(G * G);
  for (let y = 0; y < G; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= G) continue;
    for (let x = 0; x < G; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= G) continue;
      out[y * G + x] = sig[sy * G + sx];
    }
  }
  return out;
}

function sigNcc(a: Float32Array, b: Float32Array): number {
  let ma = 0;
  let mb = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 1e-9 ? num / den : 0;
}

interface TrackEntry {
  t: number;
  dx: number;
  dy: number;
}

/**
 * Предвычисленный трек смещения маски по времени: грубый поиск ±12px шагом 4
 * по сигнатуре области, затем уточнение ±2px попиксельной NCC.
 */
async function buildTrack(
  video: HTMLVideoElement,
  bbox: BBox,
  onProgress: (p: number) => void,
  cancelled: { current: boolean },
): Promise<TrackEntry[]> {
  const W = video.videoWidth;
  const H = video.videoHeight;
  const duration = video.duration;
  const steps = Math.min(24, Math.max(6, Math.round(duration * 2)));
  const tmp = document.createElement("canvas");
  tmp.width = W;
  tmp.height = H;
  const tctx = tmp.getContext("2d", { willReadFrequently: true })!;

  await seekTo(video, 0);
  await awaitFrame(video);
  tctx.drawImage(video, 0, 0, W, H);
  const baseSig = regionSignature(video, tctx, bbox.x, bbox.y, bbox.w, bbox.h);

  const out: TrackEntry[] = [{ t: 0, dx: 0, dy: 0 }];
  let prevDx = 0;
  let prevDy = 0;

  for (let s = 1; s <= steps; s++) {
    if (cancelled.current) break;
    const t = (duration * s) / steps;
    await seekTo(video, t);
    await awaitFrame(video);
    tctx.drawImage(video, 0, 0, W, H);

    // грубый поиск вокруг предыдущего смещения
    let bestDx = prevDx;
    let bestDy = prevDy;
    let bestScore = -2;
    for (let dy = prevDy - 12; dy <= prevDy + 12; dy += 4) {
      for (let dx = prevDx - 12; dx <= prevDx + 12; dx += 4) {
        const x = bbox.x + dx;
        const y = bbox.y + dy;
        if (x < 0 || y < 0 || x + bbox.w > W || y + bbox.h > H) continue;
        const sig = regionSignature(video, tctx, x, y, bbox.w, bbox.h);
        const score = sigNcc(baseSig, sig);
        if (score > bestScore) {
          bestScore = score;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }
    // уточнение ±2px попиксельной NCC на уменьшенной копии
    const cw = 64;
    const ch = Math.max(16, Math.round((bbox.h / bbox.w) * 64));
    const smallA = document.createElement("canvas");
    smallA.width = cw;
    smallA.height = ch;
    const sa = smallA.getContext("2d", { willReadFrequently: true })!;
    sa.drawImage(video, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, cw, ch);
    const aData = sa.getImageData(0, 0, cw, ch).data;
    const ref = new Float32Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) {
      const q = i << 2;
      ref[i] = aData[q] * 0.299 + aData[q + 1] * 0.587 + aData[q + 2] * 0.114;
    }
    for (let dy = bestDy - 2; dy <= bestDy + 2; dy++) {
      for (let dx = bestDx - 2; dx <= bestDx + 2; dx++) {
        const x = bbox.x + dx;
        const y = bbox.y + dy;
        if (x < 0 || y < 0 || x + bbox.w > W || y + bbox.h > H) continue;
        const smallB = document.createElement("canvas");
        smallB.width = cw;
        smallB.height = ch;
        const sb = smallB.getContext("2d", { willReadFrequently: true })!;
        sb.drawImage(video, x, y, bbox.w, bbox.h, 0, 0, cw, ch);
        const bData = sb.getImageData(0, 0, cw, ch).data;
        const cur = new Float32Array(cw * ch);
        for (let i = 0; i < cw * ch; i++) {
          const q = i << 2;
          cur[i] = bData[q] * 0.299 + bData[q + 1] * 0.587 + bData[q + 2] * 0.114;
        }
        const score = sigNcc(ref, cur);
        if (score > bestScore) {
          bestScore = score;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }

    // если область не найдена (низкая корреляция) — держим предыдущее смещение
    if (bestScore < 0.35) {
      bestDx = prevDx;
      bestDy = prevDy;
    }
    prevDx = bestDx;
    prevDy = bestDy;
    out.push({ t, dx: bestDx, dy: bestDy });
    onProgress(s / steps);
  }
  return out;
}

function offsetAt(track: TrackEntry[], t: number): { dx: number; dy: number } {
  if (track.length < 2) return { dx: 0, dy: 0 };
  if (t <= track[0].t) return { dx: track[0].dx, dy: track[0].dy };
  for (let i = 1; i < track.length; i++) {
    if (t <= track[i].t) {
      const a = track[i - 1];
      const b = track[i];
      const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return { dx: a.dx + (b.dx - a.dx) * k, dy: a.dy + (b.dy - a.dy) * k };
    }
  }
  const last = track[track.length - 1];
  return { dx: last.dx, dy: last.dy };
}

// ---------------------------- подготовка ----------------------------

interface Prepared {
  video: HTMLVideoElement;
  outCanvas: HTMLCanvasElement;
  octx: CanvasRenderingContext2D;
  W: number;
  H: number;
  duration: number;
  bbox: BBox;
  effectiveMask: HTMLCanvasElement;
  settings: Settings;
  cancelled: { current: boolean };
  track: TrackEntry[];
  emit: (p: Progress, force?: boolean) => void;
}

async function prepare(opts: ProcessOptions): Promise<Prepared> {
  const { video, settings, cancelled, onStage, onProgress } = opts;

  // видео-элемент создаётся вместе с экраном обработки — дожидаемся его и метаданных
  const t0wait = performance.now();
  while (!opts.outCanvasRef.current || video.readyState < 1) {
    if (cancelled.current) throw new Error("__cancelled__");
    if (performance.now() - t0wait > 8000) throw new Error("Не удалось получить видео для обработки");
    await sleep(50);
  }
  const outCanvas = opts.outCanvasRef.current;

  const W = video.videoWidth;
  const H = video.videoHeight;
  if (!W || !H) throw new Error("Видео не имеет кадров (нулевой размер)");
  outCanvas.width = W;
  outCanvas.height = H;
  const octx = outCanvas.getContext("2d", { willReadFrequently: true })!;
  const duration = video.duration;
  if (!isFinite(duration) || duration <= 0) {
    throw new Error("Не удалось определить длительность видео. Попробуйте другой файл (MP4/WebM).");
  }

  onStage("Ищем пиксели знака внутри выделения…");
  const eff = await buildEffectiveMask(video, opts.maskCanvas, settings.radius);
  if (!eff) throw new Error("Маска пуста — сначала выделите область водяного знака");
  if (cancelled.current) throw new Error("__cancelled__");
  const bbox = eff.bbox;
  const effectiveMask = eff.mask;

  let lastEmit = 0;
  const emit = (p: Progress, force = false) => {
    const now = performance.now();
    if (force || now - lastEmit > 120) {
      lastEmit = now;
      onProgress(p);
    }
  };

  // отслеживание движения (если включено) — до обработки
  let track: TrackEntry[] = [];
  if (settings.track) {
    onStage("Отслеживаем перемещение знака…");
    track = await buildTrack(video, bbox, (p) => emit({ pct: Math.round(p * 6), t: p * duration, duration, frames: 0, fps: 0 }), cancelled);
    if (cancelled.current) throw new Error("__cancelled__");
  }

  return { video, outCanvas, octx, W, H, duration, bbox, effectiveMask, settings, cancelled, track, emit };
}

// ---------------------------- WebCodecs: аудио ----------------------------

/**
 * Декодировать оригинальную аудиодорожку из исходного файла и привести
 * к 48 кГц stereo — эту конфигурацию поддерживают и AAC, и Opus-энкодеры.
 */
async function decodeSourceAudio(blob: Blob, maxDuration: number): Promise<AudioBuffer | null> {
  let buf: AudioBuffer;
  try {
    const ab = await blob.arrayBuffer();
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    try {
      buf = await ctx.decodeAudioData(ab.slice(0));
    } finally {
      await ctx.close().catch(() => undefined);
    }
  } catch (e) {
    console.warn("decodeAudioData не смог прочитать дорожку:", e);
    return null;
  }
  if (buf.duration < 0.05) return null; // дорожки по факту нет
  try {
    const wantRate = 48000;
    const wantCh = Math.min(2, buf.numberOfChannels);
    const dur = Math.min(buf.duration, maxDuration + 0.1);
    if (wantRate !== buf.sampleRate || wantCh !== buf.numberOfChannels) {
      const off = new OfflineAudioContext(wantCh, Math.ceil(dur * wantRate), wantRate);
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(off.destination);
      src.start(0);
      buf = await off.startRendering();
    }
    return buf;
  } catch (e) {
    console.warn("Не удалось привести аудио к 48 кГц:", e);
    return buf;
  }
}

/**
 * Реально кодируем PCM в AAC/Opus. Возвращает чанки; пустой массив = кодек
 * в этом браузере не работает. Конфигурация внутри try — никакого
 * isConfigSupported (он врёт в Firefox).
 */
async function encodeAudioChunks(
  audio: AudioBuffer,
  maxDuration: number,
  codec: "mp4a.40.2" | "opus",
  cancelled: { current: boolean },
): Promise<Array<{ chunk: any; meta: any }>> {
  const out: Array<{ chunk: any; meta: any }> = [];
  const rate = audio.sampleRate;
  const ch = audio.numberOfChannels;
  const total = Math.min(Math.floor(audio.duration * rate), Math.ceil(maxDuration * rate));
  let enc: any;
  try {
    enc = new g.AudioEncoder({
      output: (chunk: any, meta: any) => out.push({ chunk, meta }),
      error: (e: any) => console.warn("AudioEncoder:", e),
    });
    enc.configure({
      codec,
      sampleRate: rate,
      numberOfChannels: ch,
      bitrate: 192_000,
      ...(codec === "opus" ? { opus: { frameDuration: 20_000 } } : {}),
    });
  } catch (e) {
    console.warn(`AudioEncoder ${codec} не запустился:`, e);
    try {
      enc?.close();
    } catch {
      /* */
    }
    return [];
  }
  try {
    const STEP = codec === "opus" ? Math.round(rate * 0.02) * 3 : 1024; // opus ~60 мс
    for (let s = 0; s < total; s += STEP) {
      if (cancelled.current) break;
      const len = Math.min(STEP, total - s);
      const planes: Float32Array[] = [];
      for (let c = 0; c < ch; c++) planes.push(audio.getChannelData(c).subarray(s, s + len));
      const ad = new g.AudioData({
        format: "f32-planar",
        sampleRate: rate,
        numberOfFrames: len,
        numberOfChannels: ch,
        timestamp: Math.round((s / rate) * 1e6),
        data: planes,
      });
      enc.encode(ad);
      ad.close();
      while (enc.encodeQueueSize > 10) await sleep(3);
    }
    await enc.flush();
  } catch (e) {
    console.warn("Ошибка кодирования аудио:", e);
  } finally {
    try {
      enc.close();
    } catch {
      /* */
    }
  }
  return out;
}

// ---------------------------- WebCodecs: видео ----------------------------

async function pickAvcCodec(W: number, H: number, fps: number): Promise<string | null> {
  const profiles = ["avc1.640033", "avc1.640032", "avc1.640028", "avc1.4d0033", "avc1.42e033", "avc1.420033"];
  for (const codec of profiles) {
    try {
      const sup = await g.VideoEncoder.isConfigSupported({
        codec,
        width: W,
        height: H,
        bitrate: 12_000_000,
        framerate: Math.round(fps),
      });
      if (sup && sup.supported) return codec;
    } catch {
      /* пробуем следующий профиль */
    }
  }
  return null;
}

/** Подбор VP9/VP8 для WebM-контейнера (путь, когда AAC-энкодер недоступен). */
async function pickVpxCodec(W: number, H: number, fps: number): Promise<string | null> {
  for (const codec of ["vp09.00.10.08", "vp8"]) {
    try {
      const sup = await g.VideoEncoder.isConfigSupported({
        codec,
        width: W,
        height: H,
        bitrate: 12_000_000,
        framerate: Math.round(fps),
      });
      if (sup && sup.supported) return codec;
    } catch {
      /* пробуем следующий */
    }
  }
  return null;
}

interface OfflineEncode {
  chunks: Array<{ chunk: any; meta: any }>;
  decoderConfig: any;
  frames: number;
}

/**
 * Офлайн-проход: покадровый seek → восстановление → VideoEncoder.
 * Таймстампы i/fps — точное число кадров без пропусков, независимо от
 * скорости машины. Возвращает сжатые чанки + конфигурацию декодера
 * (нужна для гибридного пути с живым звуком).
 */
async function encodeVideoOffline(
  p: Prepared,
  fps: number,
  codec: string,
  encW: number,
  encH: number,
  onStage: (s: string) => void,
): Promise<OfflineEncode> {
  const { video, outCanvas, octx, W, H, duration, bbox, settings, cancelled, track, emit } = p;

  const chunks: Array<{ chunk: any; meta: any }> = [];
  let decoderConfig: any = null;
  let encoderError: Error | null = null;
  const encoder = new g.VideoEncoder({
    output: (chunk: any, meta: any) => {
      chunks.push({ chunk, meta });
      if (!decoderConfig && meta && meta.decoderConfig) decoderConfig = meta.decoderConfig;
    },
    error: (e: any) => {
      encoderError = e instanceof Error ? e : new Error(String(e?.message ?? e));
    },
  });
  const vbps = Math.min(28_000_000, Math.max(3_500_000, Math.round(encW * encH * fps * 0.16)));
  try {
    await encoder.configure({
      codec,
      width: encW,
      height: encH,
      bitrate: vbps,
      framerate: Math.round(fps),
    });
  } catch {
    throw new Error("__no_webcodecs__");
  }

  // бюджет для офлайн-пути щедрый: качество максимальное, время не критично
  const inpainter = createInpainter({
    bbox,
    maskCanvas: p.effectiveMask,
    radius: settings.radius,
    budget: 2_400_000,
    mode: settings.mode,
  });

  video.pause();
  onStage(`Восстанавливаем кадры (${Math.round(fps)} fps)…`);

  const N = Math.max(1, Math.ceil(fps * duration));
  const usecPerFrame = 1_000_000 / fps;
  const keyEvery = Math.max(1, Math.round(fps * 2));

  let frames = 0;
  const t0 = performance.now();

  for (let i = 0; i < N; i++) {
    if (cancelled.current || encoderError) break;

    const t = Math.min(Math.max(0, duration - 0.02), i / fps);
    await seekTo(video, t);
    await awaitFrame(video);

    octx.drawImage(video, 0, 0, W, H);
    const off = track.length ? offsetAt(track, t) : { dx: 0, dy: 0 };
    inpainter.runFrame(octx, Math.round(off.dx), Math.round(off.dy));

    const frame = new g.VideoFrame(outCanvas, {
      timestamp: Math.round(i * usecPerFrame),
      duration: Math.round(usecPerFrame),
      visibleRect: { left: 0, top: 0, width: encW, height: encH },
    });
    encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 4) await sleep(3);

    frames++;
    const el = (performance.now() - t0) / 1000;
    emit({ pct: 8 + Math.min(80, ((i + 1) / N) * 80), t, duration, frames, fps: el > 0.5 ? frames / el : 0 });
  }

  if (cancelled.current) {
    try {
      encoder.close();
    } catch {
      /* */
    }
    throw new Error("__cancelled__");
  }
  if (encoderError) throw encoderError;
  if (frames === 0) throw new Error("Не удалось обработать ни одного кадра");

  await encoder.flush();
  encoder.close();
  if (chunks.length === 0) throw new Error("Кодировщик не вернул данные");
  return { chunks, decoderConfig, frames };
}

/**
 * Гибридный путь для браузеров без аудиокодеров (AAC/Opus AudioEncoder
 * отсутствует, но WebCodecs-видео есть): кадры УЖЕ восстановлены и сжаты
 * офлайн (точное число кадров, полное качество), а здесь мы в реальном
 * времени проигрываем исходный файл — его ОРИГИНАЛЬНЫЙ звук пишется в
 * MediaRecorder, а видео-дорожка собирается из готовых кадров, которые
 * декодируются и рисуются на холст синхронно с currentTime источника.
 * Обработки на лету нет → кадры не пропускаются, звук — подлинный.
 */
async function replayProcessedWithLiveAudio(
  p: Prepared,
  fps: number,
  enc: OfflineEncode,
  onStage: (s: string) => void,
): Promise<ProcessResult> {
  const { video, outCanvas, octx, W, H, duration, cancelled, emit } = p;

  const mime = pickMime();
  if (!mime) throw new Error("__fallback__");
  if (typeof g.VideoDecoder === "undefined" || !enc.decoderConfig) throw new Error("__fallback__");

  outCanvas.width = W;
  outCanvas.height = H;
  const stream = outCanvas.captureStream(0);
  const vtrack = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  const manual = typeof vtrack?.requestFrame === "function";
  const capStream = manual ? stream : outCanvas.captureStream(Math.min(60, Math.max(15, Math.round(fps))));

  let recStream: MediaStream = capStream;
  let liveAudio = false;
  try {
    const audio = getAudioGraph(video);
    await audio.ctx.resume();
    const vTracks = manual && vtrack ? [vtrack] : capStream.getVideoTracks();
    recStream = new MediaStream([...vTracks, ...audio.dest.stream.getAudioTracks()]);
    liveAudio = true;
  } catch (e) {
    console.warn("Не удалось подключить аудио к записи:", e);
  }

  // декодируем готовые чанки по мере надобности (память ограничена очередью)
  const queue: any[] = [];
  let feederDone = false;
  const decoder = new g.VideoDecoder({
    output: (f: any) => queue.push(f),
    error: (e: any) => console.warn("VideoDecoder:", e),
  });
  decoder.configure(enc.decoderConfig);
  void (async () => {
    try {
      for (const { chunk } of enc.chunks) {
        if (cancelled.current) break;
        while (decoder.decodeQueueSize > 4 && !cancelled.current) await sleep(2);
        if (cancelled.current) break;
        decoder.decode(chunk);
      }
      if (!cancelled.current) await decoder.flush();
    } catch (e) {
      console.warn("VideoDecoder feeder:", e);
    } finally {
      feederDone = true;
    }
  })();

  const rec = new MediaRecorder(recStream, {
    mimeType: mime,
    videoBitsPerSecond: Math.min(16_000_000, Math.max(2_500_000, W * H * 2)),
    audioBitsPerSecond: 192_000,
  });
  const chunksOut: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunksOut.push(e.data);
  };
  const stopped = new Promise<void>((res) => {
    rec.onstop = () => res();
  });

  await seekTo(video, 0);
  await awaitFrame(video);

  // дожидаемся первого декодированного кадра, чтобы запись не началась с пустоты
  {
    const t0w = performance.now();
    while (queue.length === 0 && !feederDone && !cancelled.current && performance.now() - t0w < 2000) {
      await sleep(10);
    }
  }
  if (cancelled.current) throw new Error("__cancelled__");

  let drawn = 0;
  const drawReady = () => {
    const nowUs = video.currentTime * 1e6 + 12_000;
    let drew = 0;
    while (queue.length && queue[0].timestamp <= nowUs) {
      const f = queue.shift();
      try {
        octx.drawImage(f, 0, 0, W, H);
      } finally {
        f.close();
      }
      drew++;
    }
    if (drew > 0 && manual) vtrack?.requestFrame?.();
    drawn += drew;
    return drew;
  };
  drawReady();

  onStage("Записываем видео с оригинальным звуком…");
  rec.start(250);
  try {
    // звук элемента перенаправлен в рекордер (MediaElementSource),
    // из динамиков он не звучит
    await video.play();
  } catch {
    rec.stop();
    await stopped;
    throw new Error("Не удалось запустить воспроизведение для записи");
  }

  await new Promise<void>((resolve) => {
    const onEnd = () => {
      video.removeEventListener("ended", onEnd);
      resolve();
    };
    video.addEventListener("ended", onEnd);
    const loop = () => {
      if (cancelled.current) {
        video.removeEventListener("ended", onEnd);
        video.pause();
        resolve();
        return;
      }
      drawReady();
      emit({ pct: 88 + Math.min(8, (video.currentTime / duration) * 8), t: video.currentTime, duration, frames: drawn, fps });
      if (video.ended || (feederDone && queue.length === 0 && video.currentTime >= duration - 0.06)) {
        video.removeEventListener("ended", onEnd);
        resolve();
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  video.pause();
  rec.stop();
  await stopped;
  try {
    decoder.close();
  } catch {
    /* */
  }
  if (cancelled.current) throw new Error("__cancelled__");
  if (chunksOut.length === 0) throw new Error("__fallback__");
  return {
    blob: new Blob(chunksOut, { type: mime.split(";")[0] }),
    ext: mime.includes("mp4") ? "mp4" : "webm",
    mime,
    frames: drawn > 0 ? drawn : enc.frames,
    audio: liveAudio ? "live" : "silent",
  };
}

async function processWithWebCodecs(p: Prepared, sourceBlob: Blob, onStage: (s: string) => void): Promise<ProcessResult> {
  const { duration, cancelled, emit } = p;

  onStage("Измеряем FPS источника…");
  const fps = await measureFps(p.video, cancelled);
  if (cancelled.current) throw new Error("__cancelled__");

  const encW = p.W % 2 === 0 ? p.W : p.W + 1;
  const encH = p.H % 2 === 0 ? p.H : p.H + 1;

  // ---------- звук: декодируем оригинальную дорожку и реально пробуем кодеки ----------
  onStage("Декодируем оригинальную аудиодорожку…");
  const audioBuf = await decodeSourceAudio(sourceBlob, duration);
  if (cancelled.current) throw new Error("__cancelled__");

  // audioStatus: aac/opus — звук перенесён; none — в источнике звука нет;
  // silent — звук в источнике есть, но энкодеры не сработали (нужен запасной путь)
  let audioStatus: AudioStatus = audioBuf ? "silent" : "none";
  let container: "mp4" | "webm" = "mp4";
  let audioChunks: Array<{ chunk: any; meta: any }> = [];

  if (audioBuf) {
    // 1) AAC → контейнер MP4
    onStage("Кодируем звук (AAC)…");
    audioChunks = await encodeAudioChunks(audioBuf, duration, "mp4a.40.2", cancelled);
    if (audioChunks.length > 0) {
      audioStatus = "aac";
    } else {
      // 2) Opus → контейнер WebM
      onStage("Кодируем звук (Opus)…");
      audioChunks = await encodeAudioChunks(audioBuf, duration, "opus", cancelled);
      if (audioChunks.length > 0) {
        audioStatus = "opus";
        container = "webm";
      }
    }
    if (cancelled.current) throw new Error("__cancelled__");
  }
  const hasAudio = audioChunks.length > 0;

  // ---------- видеокодек ----------
  let codec: string | null = null;
  if (container === "mp4") {
    codec = await pickAvcCodec(encW, encH, fps);
  } else {
    codec = await pickVpxCodec(encW, encH, fps);
  }
  if (!codec) throw new Error("__no_webcodecs__");

  // ---------- офлайн-восстановление всех кадров (точное число, без пропусков) ----------
  const enc = await encodeVideoOffline(p, fps, codec, encW, encH, onStage);
  emit({ pct: 88, t: duration, duration, frames: enc.frames, fps: 0 }, true);

  // В источнике есть звук, но аудиокодеров в этом браузере нет →
  // гибридный путь: готовые кадры + запись оригинального звука в реальном времени.
  if (audioBuf && !hasAudio) {
    return await replayProcessedWithLiveAudio(p, fps, enc, onStage);
  }

  // ---------- обычный путь: собираем контейнер (видео + звук) ----------
  let muxer: any;
  if (container === "mp4") {
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      fastStart: "in-memory",
      video: { codec: "avc", width: encW, height: encH },
      audio: hasAudio
        ? { codec: "aac", numberOfChannels: audioBuf!.numberOfChannels, sampleRate: audioBuf!.sampleRate }
        : undefined,
    });
  } else {
    muxer = new WebMMuxer({
      target: new WebMArrayBufferTarget(),
      video: { codec: codec.startsWith("vp8") ? "V_VP8" : "V_VP9", width: encW, height: encH },
      audio: hasAudio
        ? { codec: "A_OPUS", numberOfChannels: audioBuf!.numberOfChannels, sampleRate: audioBuf!.sampleRate }
        : undefined,
    });
  }
  for (const { chunk, meta } of audioChunks) {
    muxer.addAudioChunk(chunk, meta);
  }
  for (const { chunk, meta } of enc.chunks) {
    muxer.addVideoChunk(chunk, meta);
  }

  emit({ pct: 97, t: duration, duration, frames: enc.frames, fps: 0 }, true);
  onStage(container === "mp4" ? "Собираем MP4-контейнер…" : "Собираем WebM-контейнер…");
  muxer.finalize();

  const buffer = (muxer.target as { buffer: ArrayBuffer }).buffer;
  if (!buffer || buffer.byteLength < 1024) throw new Error("Кодировщик не вернул данные");
  const mime = container === "mp4" ? "video/mp4" : "video/webm";
  return {
    blob: new Blob([buffer], { type: mime }),
    ext: container,
    mime,
    frames: enc.frames,
    audio: audioStatus,
  };
}

// ---------------------------- запасной путь: MediaRecorder ----------------------------

interface AudioGraph {
  ctx: AudioContext;
  dest: MediaStreamAudioDestinationNode;
}
const audioGraphs = new WeakMap<HTMLVideoElement, AudioGraph>();

function getAudioGraph(video: HTMLVideoElement): AudioGraph {
  let gr = audioGraphs.get(video);
  if (!gr) {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaElementSource(video);
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    gr = { ctx, dest };
    audioGraphs.set(video, gr);
  }
  return gr;
}

export function restoreAudible(video: HTMLVideoElement): void {
  video.muted = false;
  video.volume = 1;
}

async function processWithMediaRecorder(p: Prepared, onStage: (s: string) => void): Promise<ProcessResult> {
  const { video, outCanvas, octx, W, H, duration, bbox, settings, cancelled, track, emit } = p;

  const mime = pickMime();
  if (!mime) throw new Error("Браузер не поддерживает запись видео (MediaRecorder)");

  outCanvas.width = W;
  outCanvas.height = H;
  octx.drawImage(video, 0, 0, W, H);
  const stream = outCanvas.captureStream(0);
  const vtrack = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  const manualFrames = typeof vtrack?.requestFrame === "function";

  // ВАЖНО: видео НЕ глушим — createMediaElementSource перехватывает выход
  // элемента, и muted/volume=0 резали бы записываемую дорожку.
  let recStream: MediaStream = stream;
  let liveAudio = false;
  try {
    const audio = getAudioGraph(video);
    await audio.ctx.resume();
    const vTracks = vtrack ? [vtrack] : stream.getVideoTracks();
    recStream = new MediaStream([...vTracks, ...audio.dest.stream.getAudioTracks()]);
    liveAudio = true;
  } catch (e) {
    console.warn("Не удалось подключить аудио к записи:", e);
  }

  const rec = new MediaRecorder(recStream, {
    mimeType: mime,
    videoBitsPerSecond: Math.min(16_000_000, Math.max(2_500_000, W * H * 2)),
    audioBitsPerSecond: 192_000,
  });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((res) => {
    rec.onstop = () => res();
  });

  // бюджет реального времени: запись не должна отставать от воспроизведения,
  // иначе кадры пропускаются. Диффузия в полном разрешении сюда укладывается.
  const inpainter = createInpainter({
    bbox,
    maskCanvas: p.effectiveMask,
    radius: settings.radius,
    budget: 600_000,
    mode: settings.mode,
  });
  const inpaintCurrentFrame = (dx: number, dy: number) => inpainter.runFrame(octx, dx, dy);

  await seekTo(video, 0);
  if (cancelled.current) throw new Error("__cancelled__");

  onStage("Восстанавливаем кадры (реальное время)…");
  rec.start(manualFrames ? 250 : 500);
  try {
    await video.play();
  } catch {
    rec.stop();
    await stopped;
    throw new Error("Не удалось запустить воспроизведение для обработки");
  }

  let frames = 0;
  let lastT = -1;
  const t0 = performance.now();
  let fallbackTimer: number | null = null;
  // фолбэк для captureStream без requestFrame (Firefox): толкаем кадры таймером
  if (!manualFrames) {
    fallbackTimer = window.setInterval(() => {
      if (video.readyState >= 2 && !video.paused) {
        try {
          vtrack?.requestFrame?.();
        } catch {
          /* */
        }
      }
    }, 33);
  }

  await new Promise<void>((resolve) => {
    const onEnd = () => {
      video.removeEventListener("ended", onEnd);
      resolve();
    };
    video.addEventListener("ended", onEnd);
    const loop = () => {
      if (cancelled.current || video.ended) {
        video.removeEventListener("ended", onEnd);
        if (cancelled.current) video.pause();
        resolve();
        return;
      }
      const t = video.currentTime;
      if (video.readyState >= 2 && !video.paused && t !== lastT) {
        lastT = t;
        try {
          octx.drawImage(video, 0, 0, W, H);
          const off = track.length ? offsetAt(track, t) : { dx: 0, dy: 0 };
          inpaintCurrentFrame(Math.round(off.dx), Math.round(off.dy));
          frames++;
          if (manualFrames) vtrack?.requestFrame?.();
        } catch (e) {
          console.warn("Кадр не обработан:", e);
        }
        emit({
          pct: 8 + Math.min(88, (t / duration) * 88),
          t,
          duration,
          frames,
          fps: frames / Math.max(0.5, (performance.now() - t0) / 1000),
        });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
  video.pause();
  rec.stop();
  await stopped;
  restoreAudible(video);

  if (cancelled.current) throw new Error("__cancelled__");
  if (chunks.length === 0) throw new Error("MediaRecorder не вернул данные");
  return {
    blob: new Blob(chunks, { type: mime.split(";")[0] }),
    ext: mime.includes("mp4") ? "mp4" : "webm",
    mime,
    frames,
    audio: liveAudio ? "live" : "silent",
  };
}

// ---------------------------- точка входа ----------------------------

export async function processVideo(opts: ProcessOptions): Promise<ProcessResult | null> {
  try {
    const p = await prepare(opts);

    if (hasWebCodecs()) {
      // WebCodecs-путь сам разбирается со звуком:
      //  • есть аудиокодеры → офлайн-контейнер (MP4/WebM) с перекодированной
      //    дорожкой и ТОЧНЫМ числом кадров;
      //  • аудиокодеров нет → гибридный путь: офлайн-восстановленные кадры
      //    проигрываются синхронно с оригинальным звуком, который пишется
      //    в MediaRecorder — тоже без пропусков кадров.
      try {
        const res = await processWithWebCodecs(p, opts.sourceBlob, opts.onStage);
        // Крайняя страховка: звук в источнике есть, но ни один способ не
        // сработал → пробуем чисто рекордерный путь (он кодирует звук сам).
        if (res.audio === "silent" && !p.cancelled.current) {
          opts.onStage("Сохраняем звук: дополнительный проход (MediaRecorder)…");
          try {
            return await processWithMediaRecorder(p, opts.onStage);
          } catch (e2) {
            console.warn("Запасной проход со звуком не удался:", e2);
            return res; // остаёмся с видео без звука
          }
        }
        return res;
      } catch (e) {
        const msg = (e as Error)?.message ?? "";
        if (msg === "__cancelled__") return null;
        if (msg !== "__no_webcodecs__" && msg !== "__fallback__") {
          console.warn("WebCodecs-путь не удался, переход на MediaRecorder:", e);
        }
        opts.onStage("WebCodecs недоступен — используем MediaRecorder…");
      }
    }
    return await processWithMediaRecorder(p, opts.onStage);
  } catch (e) {
    const msg = (e as Error)?.message ?? "";
    if (msg === "__cancelled__") return null;
    throw e;
  }
}
