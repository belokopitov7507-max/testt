import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Brush,
  Eraser,
  Eye,
  EyeOff,
  Loader2,
  Scan,
  Trash2,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import type { RemovalMode } from "../lib/pipeline";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Tool = "rect" | "brush" | "eraser";
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

interface DragState {
  mode: "draw" | "move" | "resize" | "paint";
  start?: { x: number; y: number };
  lastPt?: { x: number; y: number };
  handle?: Handle;
  orig?: Rect;
  grabDx?: number;
  grabDy?: number;
}

interface UndoOp {
  kind: "region" | "stroke" | "clear";
  prev?: Rect | null;
  next?: Rect | null;
  prevStrokes?: ImageData;
  prevRegion?: Rect | null;
  prevOps?: UndoOp[];
  hadStrokes?: boolean;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const fmt = (s: number) => {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
};

interface Props {
  videoUrl: string;
  fileName: string;
  fileSize: number;
  maskCanvasRef: { current: HTMLCanvasElement | null };
  hasMask: boolean;
  setHasMask: (v: boolean) => void;
  onProcess: () => void;
  onCancel: () => void;
  onLoadedMeta: (m: { w: number; h: number; duration: number }) => void;
  mode: RemovalMode;
  setMode: (v: RemovalMode) => void;
  radius: number;
  setRadius: (v: number) => void;
  track: boolean;
  setTrack: (v: boolean) => void;
  brushSize: number;
  setBrushSize: (v: number) => void;
  notify: (msg: string, kind?: "ok" | "error" | "info") => void;
}

export default function MaskEditor({
  videoUrl,
  fileName,
  fileSize,
  maskCanvasRef,
  hasMask,
  setHasMask,
  onProcess,
  onCancel,
  onLoadedMeta,
  mode,
  setMode,
  radius,
  setRadius,
  track,
  setTrack,
  brushSize,
  setBrushSize,
  notify,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const strokesCanvas = useRef<HTMLCanvasElement>(null);
  const viewCanvasRef = useRef<HTMLCanvasElement>(null); // видимая подсветка маски
  const previewRef = useRef<HTMLCanvasElement>(null); // ВСЕГДА смонтирован
  const dragRef = useRef<DragState | null>(null);
  const regionRef = useRef<Rect | null>(null);
  const toolRef = useRef<Tool>("rect");
  const brushRef = useRef(brushSize);
  const radiusRef = useRef(radius);
  const modeRef = useRef(mode);
  const hasStrokesRef = useRef(false);
  const opsRef = useRef<UndoOp[]>([]);
  const [, setTick] = useState(0);
  const [tool, setToolState] = useState<Tool>("rect");
  const [showOriginal, setShowOriginal] = useState(false);
  const [meta, setMeta] = useState<{ w: number; h: number; duration: number } | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewOn, setPreviewOn] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  brushRef.current = brushSize;
  radiusRef.current = radius;
  modeRef.current = mode;
  const setTool = (t: Tool) => {
    toolRef.current = t;
    setToolState(t);
  };

  const setHasMaskBoth = useCallback(
    (v: boolean) => {
      setHasMask(v);
      setTick((x) => x + 1);
    },
    [setHasMask],
  );

  // ---------- композитинг маски: кисть + прямоугольник ----------
  const composite = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const mctx = maskCanvas.getContext("2d")!;
    mctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    mctx.drawImage(strokesCanvas.current!, 0, 0);
    const r = regionRef.current;
    if (r) {
      mctx.fillStyle = "#ffffff";
      mctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // видимая подсветка: тонируем всю маску (кисть И прямоугольник)
    const view = viewCanvasRef.current;
    if (view) {
      const vctx = view.getContext("2d")!;
      vctx.clearRect(0, 0, view.width, view.height);
      vctx.drawImage(maskCanvas, 0, 0);
      vctx.globalCompositeOperation = "source-in";
      vctx.fillStyle = "rgba(255, 178, 36, 0.38)";
      vctx.fillRect(0, 0, view.width, view.height);
      vctx.globalCompositeOperation = "source-over";
    }
    setHasMaskBoth(hasStrokesRef.current || !!r);
  }, [maskCanvasRef, setHasMaskBoth]);

  // ---------- превью результата (один кадр) ----------
  // ВАЖНО: previewRef указывает на канвас, который смонтирован ВСЕГДА
  // (скрывается через display) — иначе ссылка пуста и превью «не открывается».
  const doPreview = useCallback(async () => {
    if (previewBusy) return;
    if (previewOn) {
      setPreviewOn(false);
      return;
    }
    const video = videoRef.current;
    const out = previewRef.current;
    if (!video || !out || !video.videoWidth) {
      notify("Видео ещё загружается — попробуйте через секунду", "info");
      return;
    }
    setPreviewBusy(true);
    try {
      const { createInpainter } = await import("../lib/inpaint");
      const { maskBBox } = await import("../lib/pipeline");
      const W = video.videoWidth;
      const H = video.videoHeight;
      out.width = W;
      out.height = H;
      const octx = out.getContext("2d", { willReadFrequently: true })!;
      octx.drawImage(video, 0, 0, W, H);
      const mask = maskCanvasRef.current!;
      const pad = Math.min(48, radiusRef.current * 2 + 8);
      const bbox = maskBBox(mask, pad);
      if (!bbox) {
        notify("Сначала выделите область знака", "error");
        return;
      }
      const inpainter = createInpainter({
        bbox,
        maskCanvas: mask,
        radius: radiusRef.current,
        budget: 2_400_000, // превью — разовый вызов, качество максимальное
        mode: modeRef.current,
      });
      inpainter.runFrame(octx, 0, 0);
      setPreviewOn(true);
      notify("Превью построено — так будет выглядеть результат", "ok");
    } catch (e) {
      console.error(e);
      notify("Не удалось построить превью: " + ((e as Error)?.message ?? "ошибка"), "error");
    } finally {
      setPreviewBusy(false);
    }
  }, [maskCanvasRef, notify, previewBusy, previewOn]);

  // ---------- геометрия: контент-бокс видео (object-contain) ----------
  const contentBox = useCallback(() => {
    const overlay = overlayRef.current!;
    const video = videoRef.current!;
    const rect = overlay.getBoundingClientRect();
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const k = Math.min(rect.width / vw, rect.height / vh);
    const cw = vw * k;
    const ch = vh * k;
    return { ox: (rect.width - cw) / 2, oy: (rect.height - ch) / 2, cw, ch, rect };
  }, []);

  const toNative = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const video = videoRef.current!;
      const { ox, oy, cw, ch, rect } = contentBox();
      return {
        x: ((e.clientX - rect.left - ox) / Math.max(1, cw)) * video.videoWidth,
        y: ((e.clientY - rect.top - oy) / Math.max(1, ch)) * video.videoHeight,
      };
    },
    [contentBox],
  );

  const handleDisplayPos = useCallback((r: Rect, h: Handle) => {
    const cx = h.includes("w") ? r.x : h.includes("e") ? r.x + r.w : r.x + r.w / 2;
    const cy = h.includes("n") ? r.y : h.includes("s") ? r.y + r.h : r.y + r.h / 2;
    return { x: cx, y: cy };
  }, []);

  const hitHandle = useCallback(
    (e: React.PointerEvent): Handle | null => {
      const video = videoRef.current!;
      const r = regionRef.current;
      if (!r || toolRef.current !== "rect") return null;
      const { ox, oy, cw, ch, rect } = contentBox();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const th = e.pointerType === "touch" ? 18 : 11;
      const kx = cw / video.videoWidth;
      const ky = ch / video.videoHeight;
      for (const h of HANDLES) {
        const p = handleDisplayPos(r, h);
        if (Math.abs(ox + p.x * kx - px) < th && Math.abs(oy + p.y * ky - py) < th) return h;
      }
      return null;
    },
    [handleDisplayPos, contentBox],
  );

  const insideRegion = (p: { x: number; y: number }) => {
    const r = regionRef.current;
    return !!r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  };

  // ---------- кисть ----------
  const drawStrokeSeg = useCallback(
    (a: { x: number; y: number }, b: { x: number; y: number }, t: "brush" | "eraser", size: number) => {
      const sctx = strokesCanvas.current!.getContext("2d")!;
      sctx.save();
      sctx.globalCompositeOperation = t === "eraser" ? "destination-out" : "source-over";
      sctx.strokeStyle = "#ffffff";
      sctx.fillStyle = "#ffffff";
      sctx.lineWidth = size;
      sctx.lineCap = "round";
      sctx.lineJoin = "round";
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) {
        sctx.beginPath();
        sctx.arc(a.x, a.y, size / 2, 0, Math.PI * 2);
        sctx.fill();
      } else {
        sctx.beginPath();
        sctx.moveTo(a.x, a.y);
        sctx.lineTo(b.x, b.y);
        sctx.stroke();
      }
      sctx.restore();
    },
    [],
  );

  // ---------- указатель ----------
  const onPointerDown = (e: React.PointerEvent) => {
    if (!meta) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragging(true);
    setPreviewOn(false);
    const p = toNative(e);
    const video = videoRef.current!;
    p.x = clamp(p.x, 0, video.videoWidth);
    p.y = clamp(p.y, 0, video.videoHeight);

    if (toolRef.current === "rect") {
      const h = hitHandle(e);
      if (h && regionRef.current) {
        opsRef.current.push({ kind: "region", prev: { ...regionRef.current }, next: null });
        dragRef.current = { mode: "resize", handle: h, orig: { ...regionRef.current } };
      } else if (regionRef.current && insideRegion(p)) {
        dragRef.current = {
          mode: "move",
          grabDx: p.x - regionRef.current.x,
          grabDy: p.y - regionRef.current.y,
          orig: { ...regionRef.current },
        };
      } else {
        opsRef.current.push({ kind: "region", prev: regionRef.current ? { ...regionRef.current } : null, next: null });
        dragRef.current = { mode: "draw", start: p };
        regionRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
      }
    } else {
      const sctx = strokesCanvas.current!.getContext("2d")!;
      opsRef.current.push({
        kind: "stroke",
        prevStrokes: sctx.getImageData(0, 0, strokesCanvas.current!.width, strokesCanvas.current!.height),
        hadStrokes: hasStrokesRef.current,
      });
      dragRef.current = { mode: "paint", lastPt: p };
      drawStrokeSeg(p, p, toolRef.current === "brush" ? "brush" : "eraser", brushRef.current);
      hasStrokesRef.current = true;
    }
    composite();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toNative(e);
    const video = videoRef.current!;
    p.x = clamp(p.x, 0, video.videoWidth);
    p.y = clamp(p.y, 0, video.videoHeight);

    if (d.mode === "draw" && d.start) {
      regionRef.current = {
        x: Math.min(d.start.x, p.x),
        y: Math.min(d.start.y, p.y),
        w: Math.abs(p.x - d.start.x),
        h: Math.abs(p.y - d.start.y),
      };
    } else if (d.mode === "move" && d.orig) {
      regionRef.current = {
        ...d.orig,
        x: clamp(p.x - (d.grabDx ?? 0), 0, video.videoWidth - d.orig.w),
        y: clamp(p.y - (d.grabDy ?? 0), 0, video.videoHeight - d.orig.h),
      };
    } else if (d.mode === "resize" && d.orig && d.handle) {
      const o = d.orig;
      let x1 = o.x;
      let y1 = o.y;
      let x2 = o.x + o.w;
      let y2 = o.y + o.h;
      if (d.handle.includes("w")) x1 = p.x;
      if (d.handle.includes("e")) x2 = p.x;
      if (d.handle.includes("n")) y1 = p.y;
      if (d.handle.includes("s")) y2 = p.y;
      regionRef.current = {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
      };
    } else if (d.mode === "paint" && d.lastPt) {
      drawStrokeSeg(d.lastPt, p, toolRef.current === "brush" ? "brush" : "eraser", brushRef.current);
      d.lastPt = p;
      hasStrokesRef.current = true;
    }
    composite();
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === "draw") {
      const r = regionRef.current;
      if (!r || r.w < 4 || r.h < 4) regionRef.current = null;
      const op = opsRef.current[opsRef.current.length - 1];
      if (op && op.kind === "region") op.next = regionRef.current ? { ...regionRef.current } : null;
    } else if (d.mode === "move" || d.mode === "resize") {
      const op = opsRef.current[opsRef.current.length - 1];
      if (op && op.kind === "region" && d.orig) {
        op.prev = { ...d.orig };
        op.next = regionRef.current ? { ...regionRef.current } : null;
      }
    }
    dragRef.current = null;
    setDragging(false);
    composite();
  };

  // ---------- undo / clear ----------
  const undo = useCallback(() => {
    const op = opsRef.current.pop();
    if (!op) return;
    if (op.kind === "region") {
      regionRef.current = op.prev ? { ...op.prev } : null;
    } else if (op.kind === "stroke" && op.prevStrokes) {
      const sctx = strokesCanvas.current!.getContext("2d")!;
      sctx.putImageData(op.prevStrokes, 0, 0);
      hasStrokesRef.current = !!op.hadStrokes;
    } else if (op.kind === "clear") {
      if (op.prevStrokes) strokesCanvas.current!.getContext("2d")!.putImageData(op.prevStrokes, 0, 0);
      regionRef.current = op.prevRegion ? { ...op.prevRegion } : null;
      hasStrokesRef.current = !!op.hadStrokes;
      opsRef.current = op.prevOps ? op.prevOps.slice() : [];
    }
    setPreviewOn(false);
    composite();
  }, [composite]);

  const clearMask = () => {
    const sctx = strokesCanvas.current!.getContext("2d")!;
    const snap = sctx.getImageData(0, 0, strokesCanvas.current!.width, strokesCanvas.current!.height);
    const prevOps = opsRef.current.slice();
    opsRef.current.push({
      kind: "clear",
      prevStrokes: snap,
      prevRegion: regionRef.current ? { ...regionRef.current } : null,
      prevOps,
      hadStrokes: hasStrokesRef.current,
    });
    sctx.clearRect(0, 0, strokesCanvas.current!.width, strokesCanvas.current!.height);
    regionRef.current = null;
    hasStrokesRef.current = false;
    setPreviewOn(false);
    composite();
    notify("Маска очищена", "info");
  };

  // ---------- инициализация canvases ----------
  useLayoutEffect(() => {
    const video = videoRef.current!;
    const onMeta = () => {
      const W = video.videoWidth;
      const H = video.videoHeight;
      if (!W || !H) return;
      strokesCanvas.current!.width = W;
      strokesCanvas.current!.height = H;
      maskCanvasRef.current!.width = W;
      maskCanvasRef.current!.height = H;
      const view = viewCanvasRef.current!;
      view.width = W;
      view.height = H;
      const m = { w: W, h: H, duration: video.duration };
      setMeta(m);
      onLoadedMeta(m);
    };
    if (video.readyState >= 1) onMeta();
    else video.addEventListener("loadedmetadata", onMeta, { once: true });
    return () => video.removeEventListener("loadedmetadata", onMeta);
  }, [maskCanvasRef, onLoadedMeta]);

  useEffect(() => {
    const video = videoRef.current!;
    const onTime = () => setTime(video.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  const r = regionRef.current;
  const cursor = tool === "rect" ? (dragging ? "grabbing" : "crosshair") : "none";

  return (
    <div className="fade-up mx-auto w-full max-w-6xl px-5">
      {/* шапка редактора */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-mist-100">{fileName}</div>
          <div className="font-mono text-[11px] text-mist-500">
            {meta ? `${meta.w}×${meta.h} · ` : ""}
            {(fileSize / 1048576).toFixed(1)} МБ · {fmt(meta?.duration ?? 0)}
          </div>
        </div>
        <button
          onClick={onCancel}
          className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-850/80 px-4 py-2 text-[13px] font-medium text-mist-300 transition hover:border-rec-600/60 hover:text-rec-400 active:scale-[0.97]"
        >
          <X size={14} /> Другое видео
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* ---------------- видео ---------------- */}
        <div>
          <div className="relative overflow-hidden rounded-xl border border-ink-700 bg-black shadow-[0_25px_70px_-25px_rgba(0,0,0,0.9)]">
            <video
              ref={videoRef}
              src={videoUrl}
              playsInline
              preload="auto"
              controls
              className="block max-h-[62vh] w-full object-contain"
            />
            {/* невидимые рабочие канвасы */}
            <canvas ref={maskCanvasRef} className="hidden" />
            <canvas ref={strokesCanvas} className="hidden" />

            <div
              ref={overlayRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className="absolute inset-0 touch-none"
              style={{ cursor }}
            >
              {/* видимая подсветка маски (кисть + прямоугольник) */}
              <canvas ref={viewCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
              {/* подсветка прямоугольника с ручками */}
              {r && r.w > 2 && tool === "rect" && !previewOn && (
                <RegionOverlay
                  region={r}
                  contentBox={contentBox}
                  videoW={meta?.w ?? 1}
                  videoH={meta?.h ?? 1}
                  handlePos={handleDisplayPos}
                />
              )}
              {/* превью результата — канвас смонтирован ВСЕГДА, иначе ref пуст */}
              <canvas
                ref={previewRef}
                className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                style={{ display: previewOn ? undefined : "none" }}
              />
              {/* курсор кисти */}
              {tool !== "rect" && <BrushCursor overlayRef={overlayRef} contentBox={contentBox} size={brushSize} videoW={meta?.w ?? 1} />}
            </div>
            <div className="pointer-events-none absolute left-2.5 top-2.5 h-5 w-5 border-l-2 border-t-2 border-mark-400/80" />
            <div className="pointer-events-none absolute right-2.5 top-2.5 h-5 w-5 border-r-2 border-t-2 border-mark-400/80" />
            <div className="pointer-events-none absolute bottom-2.5 left-2.5 h-5 w-5 border-b-2 border-l-2 border-mark-400/80" />
            <div className="pointer-events-none absolute bottom-2.5 right-2.5 h-5 w-5 border-b-2 border-r-2 border-mark-400/80" />
            {playing && (
              <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-rec-400">
                <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-rec-500" /> rec preview
              </div>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-mist-500">
            <span>
              {fmt(time)} / {fmt(meta?.duration ?? 0)}
            </span>
            <span className="hidden sm:inline">выделение мышью/пальцем · ручки и перетаскивание · Ctrl+Z — отмена</span>
          </div>

          {/* превью-кнопка под видео */}
          <div className="mt-3 flex items-center gap-2.5">
            <button
              onClick={doPreview}
              disabled={!hasMask || previewBusy}
              className="focus-ring inline-flex items-center gap-2 rounded-xl border border-mark-500/50 bg-mark-500/10 px-5 py-2.5 text-[13px] font-semibold text-mark-300 transition hover:bg-mark-500/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {previewBusy ? <Loader2 size={15} className="animate-spin" /> : previewOn ? <EyeOff size={15} /> : <Eye size={15} />}
              {previewBusy ? "Строим превью…" : previewOn ? "Скрыть превью" : "Превью на кадре"}
            </button>
            <span className="font-mono text-[11px] text-mist-600">один кадр с текущей маской и настройками</span>
          </div>
        </div>

        {/* ---------------- панель ---------------- */}
        <aside className="flex flex-col gap-4">
          <section className="rounded-xl border border-ink-700 bg-ink-850/80 p-4">
            <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-mist-500">1 · Инструмент выделения</div>
            <div className="grid grid-cols-3 gap-2">
              <ToolBtn active={tool === "rect"} onClick={() => setTool("rect")} icon={<Scan size={17} />} label="Прямоугольник" />
              <ToolBtn active={tool === "brush"} onClick={() => setTool("brush")} icon={<Brush size={17} />} label="Кисть" />
              <ToolBtn active={tool === "eraser"} onClick={() => setTool("eraser")} icon={<Eraser size={17} />} label="Ластик" />
            </div>
            {tool !== "rect" && (
              <label className="mt-3 block">
                <div className="mb-1 flex justify-between font-mono text-[11px] text-mist-400">
                  <span>Размер кисти</span>
                  <span className="text-mark-400">{brushSize}px</span>
                </div>
                <input type="range" min={4} max={120} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} className="w-full" />
              </label>
            )}
            <div className="mt-3 flex gap-2">
              <button
                onClick={undo}
                className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 py-2 text-[13px] font-medium text-mist-300 transition hover:text-mist-100 active:scale-[0.97]"
              >
                <Undo2 size={15} /> Отменить
              </button>
              <button
                onClick={clearMask}
                className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 py-2 text-[13px] font-medium text-mist-300 transition hover:border-rec-600/60 hover:text-rec-400 active:scale-[0.97]"
              >
                <Trash2 size={15} /> Очистить
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-ink-700 bg-ink-850/80 p-4">
            <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-mist-500">2 · Способ удаления</div>
            <div className="flex flex-col gap-2">
              <ModeCard
                active={mode === "smart"}
                onClick={() => setMode("smart")}
                title="Подбор фона · Telea"
                desc="Алгоритм достраивает структуру фона под знаком — следов не остаётся. Рекомендуется."
              />
              <ModeCard
                active={mode === "dissolve"}
                onClick={() => setMode("dissolve")}
                title="Растворение"
                desc="Простой и быстрый способ: область плавно растворяется в окружении."
              />
            </div>
            {mode === "smart" && (
              <label className="mt-3 block">
                <div className="mb-1 flex justify-between font-mono text-[11px] text-mist-400">
                  <span>Радиус окрестности</span>
                  <span className="text-mark-400">{radius}px</span>
                </div>
                <input type="range" min={3} max={20} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="w-full" />
              </label>
            )}
            <label className="mt-3 flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={track}
                onChange={(e) => setTrack(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-amber-400"
              />
              <span className="text-[13px] leading-snug text-mist-300">
                <span className="font-semibold text-mist-100">Отслеживать перемещение знака</span>
                <br />
                <span className="font-mono text-[11px] text-mist-500">авто-трекинг области по кадрам</span>
              </span>
            </label>
          </section>

          <section className="flex flex-col gap-2">
            <button
              onClick={() => {
                setPreviewOn(false);
                onProcess();
              }}
              disabled={!hasMask}
              className="focus-ring group relative flex w-full items-center justify-center gap-2.5 overflow-hidden rounded-xl bg-rec-500 px-6 py-4 text-[15px] font-bold text-white shadow-[0_10px_35px_-8px_rgba(255,75,62,0.55)] transition hover:bg-rec-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              <Wand2 size={19} strokeWidth={2.4} className="transition-transform group-hover:-rotate-12" />
              Удалить водяной знак
            </button>
            {!hasMask && (
              <p className="text-center font-mono text-[11px] text-mist-600">сначала выделите область знаком</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function ToolBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`focus-ring flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-[12px] font-medium transition active:scale-[0.96] ${
        active
          ? "border-mark-500/70 bg-mark-500/15 text-mark-300 shadow-[inset_0_0_0_1px_rgba(255,178,36,0.25)]"
          : "border-ink-600 bg-ink-800 text-mist-400 hover:border-ink-500 hover:text-mist-200"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ModeCard({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button
      onClick={onClick}
      className={`focus-ring rounded-lg border px-3.5 py-3 text-left transition active:scale-[0.98] ${
        active
          ? "border-mark-500/70 bg-mark-500/12 shadow-[inset_0_0_0_1px_rgba(255,178,36,0.25)]"
          : "border-ink-600 bg-ink-800 hover:border-ink-500"
      }`}
    >
      <div className={`flex items-center gap-2 text-[13.5px] font-semibold ${active ? "text-mark-300" : "text-mist-200"}`}>
        <span
          className={`grid h-4 w-4 place-items-center rounded-full border-2 ${active ? "border-mark-400" : "border-mist-600"}`}
        >
          {active && <span className="h-1.5 w-1.5 rounded-full bg-mark-400" />}
        </span>
        {title}
      </div>
      <div className="mt-1 pl-6 text-[12px] leading-snug text-mist-500">{desc}</div>
    </button>
  );
}

function RegionOverlay({
  region,
  contentBox,
  videoW,
  videoH,
  handlePos,
}: {
  region: Rect;
  contentBox: () => { ox: number; oy: number; cw: number; ch: number };
  videoW: number;
  videoH: number;
  handlePos: (r: Rect, h: Handle) => { x: number; y: number };
}) {
  const { ox, oy, cw, ch } = contentBox();
  const kx = cw / Math.max(1, videoW);
  const ky = ch / Math.max(1, videoH);
  const left = ox + region.x * kx;
  const top = oy + region.y * ky;
  const w = region.w * kx;
  const h = region.h * ky;
  return (
    <div
      className="pointer-events-none absolute border-2 border-mark-400 bg-mark-400/10 shadow-[0_0_0_9999px_rgba(7,9,13,0.45)]"
      style={{ left, top, width: w, height: h }}
    >
      {HANDLES.map((hh) => {
        const p = handlePos(region, hh);
        return (
          <div
            key={hh}
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-[3px] border-2 border-mark-300 bg-ink-900"
            style={{ left: (p.x - region.x) * kx, top: (p.y - region.y) * ky }}
          />
        );
      })}
      <div className="absolute -top-6 left-0 rounded bg-mark-400 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-950">
        {Math.round(region.w)}×{Math.round(region.h)}
      </div>
    </div>
  );
}

function BrushCursor({
  overlayRef,
  contentBox,
  size,
  videoW,
}: {
  overlayRef: { current: HTMLDivElement | null };
  contentBox: () => { ox: number; oy: number; cw: number; ch: number };
  size: number;
  videoW: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = overlayRef.current!;
    const cur = ref.current!;
    const move = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const { ox, oy, cw } = contentBox();
      const k = cw / Math.max(1, videoW);
      const d = Math.max(6, size * k);
      cur.style.opacity = "1";
      cur.style.width = `${d}px`;
      cur.style.height = `${d}px`;
      cur.style.left = `${e.clientX - rect.left - d / 2}px`;
      cur.style.top = `${e.clientY - rect.top - d / 2}px`;
    };
    const leave = () => (cur.style.opacity = "0");
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [overlayRef, contentBox, size, videoW]);
  return <div ref={ref} className="pointer-events-none absolute rounded-full border-2 border-mark-300/90 opacity-0 transition-opacity" />;
}
