import { useCallback, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import Dropzone from "./components/Dropzone";
import MaskEditor from "./components/MaskEditor";
import ProcessingView from "./components/ProcessingView";
import ResultView from "./components/ResultView";
import { processVideo, restoreAudible, type AudioStatus, type Progress, type Settings } from "./lib/pipeline";

interface VideoFile {
  url: string;
  name: string;
  size: number;
  blob: Blob; // исходный файл — нужен для декодирования оригинального звука
}

interface Result {
  url: string;
  ext: string;
  size: number;
  frames: number;
  audio: AudioStatus;
}

interface Toast {
  id: number;
  msg: string;
  kind: "ok" | "error" | "info";
}

type Stage = "landing" | "editor" | "processing" | "result";

export default function App() {
  const [stage, setStage] = useState<Stage>("landing");
  const [file, setFile] = useState<VideoFile | null>(null);
  const [meta, setMeta] = useState<{ w: number; h: number; duration: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [progress, setProgress] = useState<Progress>({ pct: 0, t: 0, duration: 0, frames: 0, fps: 0 });
  const [stageMsg, setStageMsg] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hasMask, setHasMask] = useState(false);
  const [settings, setSettings] = useState<Settings & { brushSize: number }>({
    mode: "smart",
    radius: 7,
    track: false,
    brushSize: 28,
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const outCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cancelled = useRef({ current: false });
  const toastId = useRef(0);

  const notify = useCallback((msg: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  const onFile = useCallback((f: File) => {
    setFile((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { url: URL.createObjectURL(f), name: f.name, size: f.size, blob: f };
    });
    setMeta(null);
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setHasMask(false);
    setStage("editor");
  }, []);

  const startProcessing = useCallback(async () => {
    if (!file || !videoRef.current || !maskCanvasRef.current) return;
    cancelled.current = { current: false };
    setProgress({ pct: 0, t: 0, duration: meta?.duration ?? 0, frames: 0, fps: 0 });
    setStageMsg("Подготовка…");
    setStage("processing");
    try {
      const video = videoRef.current;
      const res = await processVideo({
        video,
        sourceBlob: file.blob,
        outCanvasRef,
        maskCanvas: maskCanvasRef.current!,
        settings: { mode: settings.mode, radius: settings.radius, track: settings.track },
        cancelled: cancelled.current,
        onStage: setStageMsg,
        onProgress: setProgress,
      });
      if (!res) {
        setStage("editor");
        notify("Обработка отменена", "info");
        return;
      }
      restoreAudible(video); // возвращаем слышимость после live-пути
      setResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url: URL.createObjectURL(res.blob), ext: res.ext, size: res.blob.size, frames: res.frames, audio: res.audio };
      });
      setStage("result");
      notify("Видео без водяного знака готово!", "ok");
      if (res.audio === "none") notify("В исходном файле аудиодорожки нет — результат тоже без звука.", "info");
      else if (res.audio === "silent") notify("Не удалось сохранить звук: в этом браузере нет нужного аудиокодера.", "error");
    } catch (e) {
      console.error(e);
      setStage("editor");
      notify((e as Error)?.message || "Не удалось обработать видео", "error");
    }
  }, [file, meta, notify, settings]);

  const resetAll = () => {
    setFile((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setMeta(null);
    setHasMask(false);
    setStage("landing");
  };

  const processingHidden = stage !== "editor";

  return (
    <div className="bg-app min-h-screen text-mist-100">
      <div className="relative z-10">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
          <button onClick={resetAll} className="focus-ring flex items-center gap-3 rounded-lg" title="На главную">
            <span className="grid h-9 w-9 place-items-center rounded-lg border border-mark-500/50 bg-mark-500/10 font-display text-[15px] font-bold text-mark-400">
              Ч
            </span>
            <span className="text-left leading-tight">
              <span className="block font-display text-[15px] font-bold tracking-tight text-mist-100">Чистокадр</span>
              <span className="block font-mono text-[10px] uppercase tracking-[0.22em] text-mist-500">watermark eraser</span>
            </span>
          </button>
          <span className="hidden font-mono text-[11px] text-mist-500 sm:block">
            Telea FMM · WebCodecs → MP4 (H.264 + AAC) · всё локально
          </span>
        </header>

        <main className="pb-10 pt-4">
          {stage === "landing" && <Dropzone onFile={onFile} onError={(m) => notify(m, "error")} />}

          {(stage === "editor" || stage === "processing") && file && (
            <>
              {/* редактор: во время обработки остаётся смонтированным, но уходит
                  за экран — видео и маски продолжают жить */}
              <div
                style={
                  processingHidden
                    ? { position: "fixed", left: -99999, top: 0, width: 10, height: 10, overflow: "hidden", opacity: 0, pointerEvents: "none" }
                    : undefined
                }
              >
                <MaskEditor
                  videoUrl={file.url}
                  fileName={file.name}
                  fileSize={file.size}
                  maskCanvasRef={maskCanvasRef}
                  hasMask={hasMask}
                  setHasMask={setHasMask}
                  onProcess={startProcessing}
                  onCancel={() => {
                    if (videoRef.current) restoreAudible(videoRef.current);
                    resetAll();
                  }}
                  onLoadedMeta={setMeta}
                  mode={settings.mode}
                  setMode={(v) => setSettings((s) => ({ ...s, mode: v }))}
                  radius={settings.radius}
                  setRadius={(v) => setSettings((s) => ({ ...s, radius: v }))}
                  track={settings.track}
                  setTrack={(v) => setSettings((s) => ({ ...s, track: v }))}
                  brushSize={settings.brushSize}
                  setBrushSize={(v) => setSettings((s) => ({ ...s, brushSize: v }))}
                  notify={notify}
                />
              </div>

              {/* рабочие элементы обработки: скрытый видео-элемент (пайплайн
                  ходит по его кадрам) и холст вывода. Живут с момента загрузки
                  файла и до конца обработки. */}
              <div className="pointer-events-none fixed left-[-9999px] top-0 opacity-0">
                <video
                  ref={(el) => {
                    if (el && videoRef.current !== el) {
                      videoRef.current = el;
                    }
                  }}
                  src={file.url}
                  playsInline
                  preload="auto"
                />
                <canvas ref={(el) => (outCanvasRef.current = el)} />
              </div>

              {stage === "processing" && (
                <ProcessingView
                  progress={progress}
                  stage={stageMsg}
                  onCancel={() => (cancelled.current.current = true)}
                  fileName={file.name}
                  mode={settings.mode}
                />
              )}
            </>
          )}

          {stage === "result" && file && result && (
            <ResultView
              url={result.url}
              ext={result.ext}
              sizeBytes={result.size}
              frames={result.frames}
              fileName={file.name}
              duration={meta?.duration ?? 0}
              audio={result.audio}
              onBackToEditor={() => setStage("editor")}
              onNewVideo={resetAll}
            />
          )}
        </main>

        <footer className="border-t border-ink-800/80 py-6 text-center font-mono text-[11px] text-mist-600">
          Telea FMM inpainting (TypeScript) · WebCodecs → MP4 (H.264 + AAC) · WebAudio — ни одного байта в сеть
        </footer>
      </div>

      {/* тосты */}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast-in pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border px-4 py-3 text-[13px] shadow-[0_15px_45px_-12px_rgba(0,0,0,0.8)] ${
              t.kind === "ok"
                ? "border-ok-500/50 bg-[#0d1a14]/95 text-mist-100"
                : t.kind === "error"
                  ? "border-rec-500/60 bg-[#1c100f]/95 text-mist-100"
                  : "border-ink-600 bg-ink-800/95 text-mist-200"
            }`}
          >
            {t.kind === "ok" ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok-400" />
            ) : t.kind === "error" ? (
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rec-400" />
            ) : (
              <Info size={16} className="mt-0.5 shrink-0 text-mark-400" />
            )}
            <span className="leading-snug">{t.msg}</span>
            <button
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
              className="ml-auto text-mist-500 transition hover:text-mist-200"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
