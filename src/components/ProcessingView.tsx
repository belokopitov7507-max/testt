import { Loader2, X } from "lucide-react";
import type { Progress, RemovalMode } from "../lib/pipeline";

interface Props {
  progress: Progress;
  stage: string;
  onCancel: () => void;
  fileName: string;
  mode: RemovalMode;
}

export default function ProcessingView({ progress, stage, onCancel, fileName, mode }: Props) {
  const pct = Math.round(progress.pct);
  return (
    <div className="fade-up mx-auto w-full max-w-3xl px-5">
      <div className="overflow-hidden rounded-2xl border border-ink-700 bg-ink-850/80 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="pulse-dot inline-block h-2.5 w-2.5 rounded-full bg-rec-500" />
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-mist-400">обработка</span>
          </div>
          <div className="max-w-[50%] truncate font-mono text-[12px] text-mist-500">{fileName}</div>
        </div>

        <div className="p-6 sm:p-8">
          <div className="flex items-end justify-between">
            <div className="font-display text-5xl font-bold tabular-nums tracking-tight text-mist-100">
              {pct}
              <span className="text-2xl text-mist-500">%</span>
            </div>
            <div className="text-right font-mono text-[12px] leading-relaxed text-mist-500">
              <div>
                кадр <span className="text-mist-200">{progress.frames}</span>
              </div>
              <div>
                {progress.t.toFixed(1)} / {progress.duration.toFixed(1)} с
                {progress.fps > 0 && (
                  <>
                    {" · "}
                    <span className="text-mist-200">{progress.fps.toFixed(1)} к/с</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="mt-5 h-3.5 overflow-hidden rounded-full border border-ink-600 bg-ink-900">
            <div
              className="bar-stripes h-full rounded-full bg-gradient-to-r from-mark-600 via-mark-400 to-rec-400 transition-[width] duration-200 ease-out"
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>

          <div className="mt-4 flex items-center gap-2.5 text-[14px] text-mist-300">
            <Loader2 size={16} className="animate-spin text-mark-400" />
            {stage}
          </div>

          <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              ["Режим", mode === "smart" ? "Подбор фона · Telea" : "Растворение"],
              ["Звук", "оригинал · AAC/Opus"],
              ["FPS", "как в источнике"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-ink-700 bg-ink-800/70 px-3.5 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-mist-500">{k}</div>
                <div className="mt-1 font-mono text-[13px] font-semibold text-mist-200">{v}</div>
              </div>
            ))}
          </div>

          <button
            onClick={onCancel}
            className="focus-ring mt-7 inline-flex items-center gap-2 rounded-lg border border-ink-600 bg-ink-800 px-5 py-2.5 text-[13px] font-semibold text-mist-300 transition hover:border-rec-600/70 hover:text-rec-400 active:scale-[0.97]"
          >
            <X size={15} /> Отменить обработку
          </button>
        </div>
      </div>
      <p className="mt-4 text-center font-mono text-[11px] text-mist-600">
        Всё происходит на вашем устройстве — ни один байт не отправляется в сеть.
      </p>
    </div>
  );
}
