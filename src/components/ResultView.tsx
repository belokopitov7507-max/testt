import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Film,
  HardDrive,
  PencilRuler,
  TimerReset,
  Volume2,
} from "lucide-react";
import type { AudioStatus } from "../lib/pipeline";

interface Props {
  url: string;
  ext: string;
  sizeBytes: number;
  frames: number;
  fileName: string;
  duration: number;
  audio: AudioStatus;
  onBackToEditor: () => void;
  onNewVideo: () => void;
}

const AUDIO_LABEL: Record<AudioStatus, string> = {
  aac: "AAC · оригинал",
  opus: "Opus · оригинал",
  live: "оригинал (live)",
  silent: "без звука",
  none: "нет в источнике",
};

function fmt(t: number): string {
  if (!isFinite(t)) return "—";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function ResultView({
  url,
  ext,
  sizeBytes,
  frames,
  fileName,
  duration,
  audio,
  onBackToEditor,
  onNewVideo,
}: Props) {
  return (
    <div className="fade-up mx-auto w-full max-w-4xl px-5 pb-16">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-ok-500/15 text-ok-500">
          <CheckCircle2 size={22} />
        </span>
        <div>
          <div className="font-display text-xl font-bold tracking-tight text-mist-100">Готово — знак удалён</div>
          <div className="font-mono text-[12px] text-mist-500">
            {fileName} → {fileName.replace(/\.[^.]+$/, "")}_clean.{ext}
          </div>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-xl border border-ink-700 bg-black shadow-[0_25px_70px_-25px_rgba(0,0,0,0.9)]">
        <video src={url} controls playsInline className="block max-h-[56vh] w-full object-contain" />
        <div className="pointer-events-none absolute left-2.5 top-2.5 h-5 w-5 border-l-2 border-t-2 border-ok-500/70" />
        <div className="pointer-events-none absolute right-2.5 top-2.5 h-5 w-5 border-r-2 border-t-2 border-ok-500/70" />
      </div>

      {(audio === "silent" || audio === "none") && (
        <div
          className={`mt-4 flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[13px] ${
            audio === "silent" ? "border-rec-500/50 bg-rec-600/15 text-mist-200" : "border-ink-600 bg-ink-800/80 text-mist-400"
          }`}
        >
          {audio === "silent" ? (
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rec-400" />
          ) : (
            <Volume2 size={16} className="mt-0.5 shrink-0 text-mist-500" />
          )}
          <span className="leading-snug">
            {audio === "silent"
              ? "Звук не удалось сохранить: браузер не предоставил аудиокодер (AAC/Opus). Попробуйте Chrome или Edge — там аудиодорожка переносится полностью."
              : "В исходном файле аудиодорожки нет, поэтому результат тоже без звука."}
          </span>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(
          [
            [Film, "Формат", ext.toUpperCase()],
            [HardDrive, "Размер", (sizeBytes / 1048576).toFixed(1) + " МБ"],
            [TimerReset, "Длительность", fmt(duration)],
            [PencilRuler, "Кадров", String(frames)],
            [Volume2, "Звук", AUDIO_LABEL[audio]],
          ] as [typeof Film, string, string][]
        ).map(([Icon, k, v]) => (
          <div key={k} className="rounded-lg border border-ink-700 bg-ink-850/80 px-3.5 py-3">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-mist-500">
              <Icon size={12} className="text-mark-400" /> {k}
            </div>
            <div className="mt-1 font-mono text-[15px] font-semibold text-mist-100">{v}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <a
          href={url}
          download={`${fileName.replace(/\.[^.]+$/, "")}_clean.${ext}`}
          className="focus-ring inline-flex items-center gap-2.5 rounded-xl bg-rec-500 px-7 py-3.5 text-[15px] font-bold text-white shadow-[0_10px_35px_-8px_rgba(255,75,62,0.6)] transition hover:bg-rec-400 active:scale-[0.97]"
        >
          <Download size={18} strokeWidth={2.4} />
          Скачать видео
        </a>
        <button
          onClick={onBackToEditor}
          className="focus-ring rounded-xl border border-ink-600 bg-ink-800 px-6 py-3.5 text-[14px] font-semibold text-mist-200 transition hover:border-ink-500 hover:text-mist-100 active:scale-[0.97]"
        >
          Вернуться в редактор
        </button>
        <button
          onClick={onNewVideo}
          className="focus-ring rounded-xl px-5 py-3.5 text-[14px] font-semibold text-mist-400 transition hover:text-rec-400 active:scale-[0.97]"
        >
          Новое видео
        </button>
      </div>

      <p className="mt-5 font-mono text-[11px] leading-relaxed text-mist-500">
        Файл создан полностью на вашем устройстве: покадровый inpainting + кодирование в браузере.
        Исходное разрешение, FPS и длительность сохранены
        {audio === "aac" || audio === "opus" || audio === "live" ? ", оригинальная аудиодорожка перенесена." : "."}
      </p>
    </div>
  );
}
