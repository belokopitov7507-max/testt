// ============================================================================
// Движок восстановления изображения (inpainting), чистый TypeScript.
//
// Режим «Подбор фона» — алгоритм A. Telea («An Image Inpainting Technique
// Based on the Fast Marching Method», 2004): волна распространяется от
// границы маски внутрь, каждый пиксель получает цвет как взвешенную сумму
// внешних известных соседей с продолжением градиента изображения.
//
// Режим «Растворение» — диффузионное (гармоническое) заполнение области
// с растушёвкой границы: знак плавно растворяется в окружении.
//
// Качество:
//   • grain transfer — перенос уровня плёночного шума фона в зону;
//   • НИКАКОГО даунскейла: малые маски — Telea полным радиусом, большие —
//     гармоническая диффузия в полном разрешении (апскейла нет → нет
//     размытия), время кадра ограничено числом итераций, а не масштабом.
// ============================================================================

const KNOWN = 0;
const BAND = 1;
const INSIDE = 2;

/** Бинарная куча минимумов по ключу T (приоритет фронта волны). */
class MinHeap {
  private idx: Int32Array;
  private key: Float32Array;
  size = 0;

  constructor(cap: number, key: Float32Array) {
    this.idx = new Int32Array(cap + 8);
    this.key = key;
  }

  push(i: number): void {
    const a = this.idx;
    const k = this.key;
    let j = this.size++;
    while (j > 0) {
      const p = (j - 1) >> 1;
      if (k[a[p]] <= k[i]) break;
      a[j] = a[p];
      j = p;
    }
    a[j] = i;
  }

  pop(): number {
    const a = this.idx;
    const k = this.key;
    const top = a[0];
    const last = a[--this.size];
    let j = 0;
    for (;;) {
      const l = j * 2 + 1;
      if (l >= this.size) break;
      let m = l;
      const r = l + 1;
      if (r < this.size && k[a[r]] < k[a[l]]) m = r;
      if (k[last] <= k[a[m]]) break;
      a[j] = a[m];
      j = m;
    }
    a[j] = last;
    return top;
  }
}

/** Локальное решение уравнения эйконала |∇T| = 1 по известным соседям. */
function solveEikonal(i: number, x: number, y: number, w: number, h: number, T: Float32Array, flag: Uint8Array): number {
  let tX = Infinity;
  let tY = Infinity;
  if (x > 0 && flag[i - 1] === KNOWN) tX = Math.min(tX, T[i - 1]);
  if (x < w - 1 && flag[i + 1] === KNOWN) tX = Math.min(tX, T[i + 1]);
  if (y > 0 && flag[i - w] === KNOWN) tY = Math.min(tY, T[i - w]);
  if (y < h - 1 && flag[i + w] === KNOWN) tY = Math.min(tY, T[i + w]);

  if (tX < Infinity && tY < Infinity) {
    const d = (tX - tY) * (tX - tY);
    if (d <= 2) return (tX + tY + Math.sqrt(2 - d)) * 0.5;
    return Math.max(tX, tY) + 0.7071067811865476;
  }
  if (tX < Infinity) return tX + 1;
  if (tY < Infinity) return tY + 1;
  return 1;
}

export interface DiskOffset {
  dx: number;
  dy: number;
  d2: number;
  dist: number;
  invDist: number;
}

const diskCache = new Map<number, DiskOffset[]>();

function buildDisk(radius: number): DiskOffset[] {
  const r = Math.max(2, Math.min(24, Math.round(radius)));
  const cached = diskCache.get(r);
  if (cached) return cached;
  const r2 = r * r;
  const out: DiskOffset[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > 0 && d2 <= r2) {
        const dist = Math.sqrt(d2);
        out.push({ dx, dy, d2, dist, invDist: 1 / dist });
      }
    }
  }
  diskCache.set(r, out);
  return out;
}

/** Быстрое приближение нормального распределения (Box–Muller). */
function gauss(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Оценка уровня шума (σ) в известной зоне по лапласиану:
 * для белого шума Var(∇²I) = 20·σ². Только пиксели вдали от маски;
 * число отсчётов ограничено, чтобы не съедать бюджет кадра.
 */
function estimateNoise(data: Uint8ClampedArray, w: number, h: number, wasInside: Uint8Array): number {
  let sum = 0;
  let cnt = 0;
  for (let y = 2; y < h - 2 && cnt < 20000; y += 1) {
    const row = y * w;
    for (let x = 2; x < w - 2 && cnt < 20000; x += 1) {
      const i = row + x;
      if (wasInside[i]) continue;
      let clean = true;
      for (let dy = -2; dy <= 2 && clean; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (wasInside[i + dy * w + dx]) {
            clean = false;
            break;
          }
        }
      }
      if (!clean) continue;
      const p4 = i << 2;
      const l = (c: number) => (data[c] * 77 + data[c + 1] * 150 + data[c + 2] * 29) >> 8;
      const lap = 4 * l(p4) - l(p4 - 4) - l(p4 + 4) - l((i - w) << 2) - l((i + w) << 2);
      sum += lap * lap;
      cnt++;
    }
  }
  if (cnt < 64) return 0;
  return Math.sqrt(sum / (20 * cnt));
}

/** Перенос шума фона в восстановленную зону (против «гладкой заплатки»). */
function applyGrain(img: ImageData, wasInside: Uint8Array): void {
  const sigma = estimateNoise(img.data, img.width, img.height, wasInside);
  if (sigma < 0.75) return;
  const sLuma = sigma * 0.9;
  const sChroma = sigma * 0.45;
  const w = img.width;
  const h = img.height;
  const n = w * h;
  const data = img.data;
  for (let i = 0; i < n; i++) {
    if (!wasInside[i]) continue;
    const i4 = i << 2;
    const nl = gauss() * sLuma;
    let v = data[i4] + nl + gauss() * sChroma;
    data[i4] = v < 0 ? 0 : v > 255 ? 255 : v;
    v = data[i4 + 1] + nl + gauss() * sChroma;
    data[i4 + 1] = v < 0 ? 0 : v > 255 ? 255 : v;
    v = data[i4 + 2] + nl + gauss() * sChroma;
    data[i4 + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
    data[i4 + 3] = 255;
  }
}

/**
 * Восстановление области изображения (режим Telea).
 * @param img       ImageData области (изменяется in-place)
 * @param maskAlpha маска той же области: > 120 = восстанавливать
 * @param radius    радиус окрестности, px
 * @returns true, если были восстановлены пиксели
 */
export function inpaintTelea(
  img: ImageData,
  maskAlpha: Uint8ClampedArray | Uint8Array,
  radius: number,
): boolean {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  if (n < 4) return false;
  const data = img.data;

  const flag = new Uint8Array(n);
  const wasInside = new Uint8Array(n);
  let insideCount = 0;
  for (let i = 0; i < n; i++) {
    if (maskAlpha[i] > 120) {
      flag[i] = INSIDE;
      wasInside[i] = 1;
      insideCount++;
    }
  }
  if (insideCount === 0) return false;
  if (insideCount === n) return false; // вся область — маска: восстанавливать неоткуда

  const T = new Float32Array(n);
  for (let i = 0; i < n; i++) T[i] = flag[i] === INSIDE ? Infinity : 0;

  const heap = new MinHeap(n, T);

  // инициируем узкую полосу: INSIDE-пиксели, смежные с известными
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (flag[i] !== INSIDE) continue;
      let border = false;
      for (let dy = -1; dy <= 1 && !border; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (flag[yy * w + xx] !== INSIDE) {
            border = true;
            break;
          }
        }
      }
      if (border) {
        flag[i] = BAND;
        T[i] = solveEikonal(i, x, y, w, h, T, flag);
        heap.push(i);
      }
    }
  }

  const disk = buildDisk(radius);

  while (heap.size > 0) {
    const p = heap.pop();
    if (flag[p] === KNOWN) continue; // устаревшая запись кучи
    flag[p] = KNOWN;

    const px = p % w;
    const py = (p - px) / w;

    // градиент времени волны ∇T(p)
    const tL = px > 0 && flag[p - 1] === KNOWN ? T[p - 1] : T[p];
    const tR = px < w - 1 && flag[p + 1] === KNOWN ? T[p + 1] : T[p];
    const tU = py > 0 && flag[p - w] === KNOWN ? T[p - w] : T[p];
    const tD = py < h - 1 && flag[p + w] === KNOWN ? T[p + w] : T[p];
    const gtx = (tR - tL) * 0.5;
    const gty = (tD - tU) * 0.5;
    const gLen = Math.sqrt(gtx * gtx + gty * gty);

    // взвешенное продолжение цвета и градиентов изображения
    let sw = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let k = 0; k < disk.length; k++) {
      const o = disk[k];
      const qx = px + o.dx;
      const qy = py + o.dy;
      if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
      const q = qy * w + qx;
      if (flag[q] !== KNOWN) continue;

      // weight = dir·lev·dst = |∇T·d|·lev / d² — без sqrt в горячем цикле
      const dot = gtx * o.dx + gty * o.dy;
      const dotAbs = dot < 0 ? -dot : dot;
      const lev = 1 / (1 + T[q]);
      let weight: number;
      if (gLen < 1e-6 || dotAbs < 1e-4 * o.dist) {
        weight = 1e-3 * lev * o.invDist; // вырожденный фронт
      } else {
        weight = (dotAbs * lev) / o.d2;
      }

      const q4 = q << 2;
      // градиент изображения в q (центральные разности по известным)
      const ql = qx > 0 && flag[q - 1] === KNOWN ? q - 1 : q;
      const qr = qx < w - 1 && flag[q + 1] === KNOWN ? q + 1 : q;
      const qu = qy > 0 && flag[q - w] === KNOWN ? q - w : q;
      const qdIdx = qy < h - 1 ? q + w : q;
      const l4 = ql << 2;
      const r4 = qr << 2;
      const u4 = qu << 2;
      const d4 = qdIdx << 2;

      // I(p) ≈ I(q) + ∇I(q)·(p−q);  p−q = (−dx, −dy)
      const mx = -o.dx;
      const my = -o.dy;
      sr += weight * (data[q4] + (data[r4] - data[l4]) * 0.5 * mx + (data[d4] - data[u4]) * 0.5 * my);
      sg += weight * (data[q4 + 1] + (data[r4 + 1] - data[l4 + 1]) * 0.5 * mx + (data[d4 + 1] - data[u4 + 1]) * 0.5 * my);
      sb += weight * (data[q4 + 2] + (data[r4 + 2] - data[l4 + 2]) * 0.5 * mx + (data[d4 + 2] - data[u4 + 2]) * 0.5 * my);
      sw += weight;
    }

    const p4 = p << 2;
    if (sw > 1e-9) {
      let v = sr / sw;
      data[p4] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = sg / sw;
      data[p4 + 1] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = sb / sw;
      data[p4 + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
      data[p4 + 3] = 255;
    } else {
      // страховка: среднее известных 8-соседей
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = px + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (flag[q] !== KNOWN) continue;
          const q4 = q << 2;
          ar += data[q4];
          ag += data[q4 + 1];
          ab += data[q4 + 2];
          cnt++;
        }
      }
      if (cnt > 0) {
        data[p4] = ar / cnt;
        data[p4 + 1] = ag / cnt;
        data[p4 + 2] = ab / cnt;
        data[p4 + 3] = 255;
      }
    }

    // релаксация соседей: расширяем фронт
    for (let dy = -1; dy <= 1; dy++) {
      const yy = py + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = px + dx;
        if (xx < 0 || xx >= w) continue;
        const nb = yy * w + xx;
        if (flag[nb] === INSIDE) {
          flag[nb] = BAND;
          T[nb] = solveEikonal(nb, xx, yy, w, h, T, flag);
          heap.push(nb);
        }
      }
    }
  }

  // grain transfer: оцениваем σ фона и добавляем такой же шум в зону
  applyGrain(img, wasInside);
  return true;
}

/** Переносимый box-blur (для браузеров без canvas.filter). */
export function boxBlurRGBA(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let R = 0;
      let G = 0;
      let B = 0;
      let cnt = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= w) continue;
        const q = (row + xx) << 2;
        R += src[q];
        G += src[q + 1];
        B += src[q + 2];
        cnt++;
      }
      const q = (row + x) << 2;
      tmp[q] = R / cnt;
      tmp[q + 1] = G / cnt;
      tmp[q + 2] = B / cnt;
      tmp[q + 3] = 255;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let R = 0;
      let G = 0;
      let B = 0;
      let cnt = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= h) continue;
        const q = (yy * w + x) << 2;
        R += tmp[q];
        G += tmp[q + 1];
        B += tmp[q + 2];
        cnt++;
      }
      const q = (y * w + x) << 2;
      out[q] = R / cnt;
      out[q + 1] = G / cnt;
      out[q + 2] = B / cnt;
      out[q + 3] = 255;
    }
  }
  return out;
}

// ============================================================================
// Диффузионное (гармоническое) заполнение — основа «Растворения» и
// качественного фолбэка для больших масок в «Подборе фона»
// ============================================================================

/**
 * Инициализация внутренности маски блоковыми средними фона
 * (билинейная интерполяция сетки средних) — пространственно-переменный
 * гладкий фон вместо одноцветного пятна.
 */
function blockMeanInit(d: Uint8ClampedArray, mask: Uint8Array, w: number, h: number, inside: Int32Array, count: number): void {
  let gr = 0;
  let gg = 0;
  let gb = 0;
  let gk = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) continue;
    const q = i << 2;
    gr += d[q];
    gg += d[q + 1];
    gb += d[q + 2];
    gk++;
  }
  const mr = gk > 0 ? gr / gk : 128;
  const mg = gk > 0 ? gg / gk : 128;
  const mb = gk > 0 ? gb / gk : 128;

  const B = 16;
  const gw = Math.ceil(w / B);
  const gh = Math.ceil(h / B);
  const bn = gw * gh;
  const br = new Float32Array(bn);
  const bg = new Float32Array(bn);
  const bb = new Float32Array(bn);
  const bc = new Float32Array(bn);
  for (let y = 0; y < h; y++) {
    const by = ((y / B) | 0) * gw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (mask[i]) continue;
      const bi = by + ((x / B) | 0);
      const q = i << 2;
      br[bi] += d[q];
      bg[bi] += d[q + 1];
      bb[bi] += d[q + 2];
      bc[bi]++;
    }
  }
  for (let i = 0; i < bn; i++) {
    if (bc[i] > 0) {
      br[i] /= bc[i];
      bg[i] /= bc[i];
      bb[i] /= bc[i];
    } else {
      br[i] = mr;
      bg[i] = mg;
      bb[i] = mb;
    }
  }
  const sample = (arr: Float32Array, x: number, y: number): number => {
    const fx = Math.min(gw - 1.001, Math.max(0, x / B - 0.5));
    const fy = Math.min(gh - 1.001, Math.max(0, y / B - 0.5));
    const x0 = fx | 0;
    const y0 = fy | 0;
    const tx = fx - x0;
    const ty = fy - y0;
    const x1 = Math.min(gw - 1, x0 + 1);
    const y1 = Math.min(gh - 1, y0 + 1);
    const top = arr[y0 * gw + x0] * (1 - tx) + arr[y0 * gw + x1] * tx;
    const bot = arr[y1 * gw + x0] * (1 - tx) + arr[y1 * gw + x1] * tx;
    return top * (1 - ty) + bot * ty;
  };
  for (let k = 0; k < count; k++) {
    const i = inside[k];
    const x = i % w;
    const y = (i - x) / w;
    const q = i << 2;
    d[q] = sample(br, x, y);
    d[q + 1] = sample(bg, x, y);
    d[q + 2] = sample(bb, x, y);
  }
}

/**
 * Диффузионное заполнение: итеративное усреднение (Гаусс–Зейдель) пикселей
 * маски по 4 соседям; граница зафиксирована. Результат — гладкое
 * гармоническое продолжение фона: знак «растворяется».
 */
export function diffusionFill(img: ImageData, mask: Uint8Array, passes: number): boolean {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  const d = img.data;

  const inside = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i]) inside[count++] = i;
  }
  if (count === 0 || count === n) return false;

  blockMeanInit(d, mask, w, h, inside, count);

  const P = Math.max(10, Math.min(120, Math.round(passes)));
  for (let pass = 0; pass < P; pass++) {
    for (let k = 0; k < count; k++) {
      const i = inside[k];
      const x = i % w;
      const y = (i - x) / w;
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      if (x > 0) {
        const q = (i - 1) << 2;
        r += d[q];
        g += d[q + 1];
        b += d[q + 2];
        c++;
      }
      if (x < w - 1) {
        const q = (i + 1) << 2;
        r += d[q];
        g += d[q + 1];
        b += d[q + 2];
        c++;
      }
      if (y > 0) {
        const q = (i - w) << 2;
        r += d[q];
        g += d[q + 1];
        b += d[q + 2];
        c++;
      }
      if (y < h - 1) {
        const q = (i + w) << 2;
        r += d[q];
        g += d[q + 1];
        b += d[q + 2];
        c++;
      }
      if (c > 0) {
        const q = i << 2;
        d[q] = r / c;
        d[q + 1] = g / c;
        d[q + 2] = b / c;
      }
    }
  }
  return true;
}

/**
 * Растушёвка: для каждого пикселя вне маски — расстояние (chamfer) до маски;
 * alpha плавно спадает до 0 на расстоянии feather px. Внутри маски — 1.
 */
function featherAlpha(mask: Uint8Array, w: number, h: number, feather: number): Float32Array {
  const n = w * h;
  const dist = new Float32Array(n);
  const INF = 1e9;
  for (let i = 0; i < n; i++) dist[i] = mask[i] ? 0 : INF;
  const D = 1.4142135;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let v = dist[i];
      if (v > 0) {
        if (x > 0) {
          const t = dist[i - 1] + 1;
          if (t < v) v = t;
        }
        if (y > 0) {
          const t = dist[i - w] + 1;
          if (t < v) v = t;
          if (x > 0) {
            const t2 = dist[i - w - 1] + D;
            if (t2 < v) v = t2;
          }
          if (x < w - 1) {
            const t2 = dist[i - w + 1] + D;
            if (t2 < v) v = t2;
          }
        }
        dist[i] = v;
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      let v = dist[i];
      if (v > 0) {
        if (x < w - 1) {
          const t = dist[i + 1] + 1;
          if (t < v) v = t;
        }
        if (y < h - 1) {
          const t = dist[i + w] + 1;
          if (t < v) v = t;
          if (x < w - 1) {
            const t2 = dist[i + w + 1] + D;
            if (t2 < v) v = t2;
          }
          if (x > 0) {
            const t2 = dist[i + w - 1] + D;
            if (t2 < v) v = t2;
          }
        }
        dist[i] = v;
      }
    }
  }
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    alpha[i] = mask[i] ? 1 : Math.max(0, 1 - dist[i] / feather);
  }
  return alpha;
}

// ============================================================================
// Адаптивный оркестратор: фиксированное время кадра при любом размере маски
// ============================================================================

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RemovalMode = "smart" | "dissolve";

export interface InpainterOptions {
  bbox: BBox;
  maskCanvas: HTMLCanvasElement; // полноразмерная маска (белый alpha = зона)
  radius: number;
  /** бюджет ≈ допустимое число операций на кадр */
  budget: number;
  /** smart = «Подбор фона» (Telea), dissolve = «Растворение» */
  mode?: RemovalMode;
}

export interface Inpainter {
  runFrame(octx: CanvasRenderingContext2D, dx: number, dy: number): void;
}

const CROSS2: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
];

function mkCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d", { willReadFrequently: true })!];
}

export function createInpainter(opts: InpainterOptions): Inpainter {
  const { bbox, maskCanvas } = opts;
  const mode: RemovalMode = opts.mode === "dissolve" ? "dissolve" : "smart";
  const bw = bbox.w;
  const bh = bbox.h;
  const n = bw * bh;
  const radius = Math.max(2, Math.min(24, Math.round(opts.radius)));
  const feather = Math.max(3, Math.min(9, Math.round(Math.min(bw, bh) * 0.05) + 2));
  const realtime = opts.budget <= 650_000;

  const [maskRoiC, maskRoiCtx] = mkCanvas(bw, bh);
  const maskFull = new Uint8Array(n);

  // smart: Telea полным радиусом, пока маска укладывается в бюджет;
  // для больших масок — гармоническая диффузия в ПОЛНОМ разрешении
  const teleaThreshold = realtime ? 7_000 : 22_000;
  let inited = false;
  let teleaFull = true;
  let teleaR = radius;

  const init = (count: number) => {
    if (mode === "smart") {
      teleaFull = count <= teleaThreshold;
      if (!teleaFull) {
        teleaR = Math.max(3, Math.floor(Math.sqrt(Math.max(1, opts.budget / Math.max(1, count)) / Math.PI)));
      }
    }
    inited = true;
  };

  const passesFor = (count: number) => {
    const base = realtime ? 2_400_000 : 9_000_000;
    return Math.max(30, Math.min(110, Math.round(base / Math.max(2000, count))));
  };

  const runFrame = (octx: CanvasRenderingContext2D, dx: number, dy: number) => {
    // 1) маска ROI с крестовым расширением ~2px (перехват гало/антиалиасинга)
    maskRoiCtx.clearRect(0, 0, bw, bh);
    const ox = -bbox.x + dx;
    const oy = -bbox.y + dy;
    for (let k = 0; k < CROSS2.length; k++) {
      maskRoiCtx.drawImage(maskCanvas, ox + CROSS2[k][0], oy + CROSS2[k][1]);
    }
    const md = maskRoiCtx.getImageData(0, 0, bw, bh).data;
    let count = 0;
    for (let i = 0, j = 3; i < n; i++, j += 4) {
      if (md[j] > 120) {
        maskFull[i] = 255;
        count++;
      } else {
        maskFull[i] = 0;
      }
    }
    if (count === 0 || count === n) return;

    if (!inited) init(count);

    // 2) исходный ROI кадра
    const img = octx.getImageData(bbox.x, bbox.y, bw, bh);

    if (mode === "smart" && teleaFull) {
      inpaintTelea(img, maskFull, teleaR);
    } else {
      // диффузия в полном разрешении + растушёвка границы
      const orig = new Uint8ClampedArray(img.data);
      diffusionFill(img, maskFull, passesFor(count));
      const alpha = featherAlpha(maskFull, bw, bh, feather);
      const d = img.data;
      for (let i = 0; i < n; i++) {
        if (maskFull[i]) continue;
        const a = alpha[i];
        if (a <= 0) continue;
        const q = i << 2;
        d[q] = orig[q] + (d[q] - orig[q]) * a;
        d[q + 1] = orig[q + 1] + (d[q + 1] - orig[q + 1]) * a;
        d[q + 2] = orig[q + 2] + (d[q + 2] - orig[q + 2]) * a;
      }
    }

    // 3) зерно в полном разрешении — против «гладкой заплатки»
    applyGrain(img, maskFull);
    octx.putImageData(img, bbox.x, bbox.y);
  };

  return { runFrame };
}
