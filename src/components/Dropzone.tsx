import { useCallback, useRef, useState } from "react";
import { Clapperboard, Cpu, FileVideo, Loader2, ShieldCheck, Upload, Volume2 } from "lucide-react";
import { generateDemoVideo } from "../lib/demo";

interface Props {
  onFile: (f: File) => void;
  onError: (msg: string) => void;
}

const ACCEPT = "video/mp4,video/webm,video/quicktime";

export default function Dropzone({ onFile, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [demo, setDemo] = useState(0); // 0 = нет, >0 = прогресс %

  const take = useCallback(
    (f: File | undefined | null) => {
      if (!f) return;
      const ok =
        f.type === "video/mp4" ||
        f.type === "video/webm" ||
        /\.(mp4|webm|m4v|mov)$/i.test(f.name);
      if (!ok) {
        onError("Нужен файл MP4 или WebM");
        return;
      }
      if (f.size > 500 * 1024 * 1024) {
        onError("Файл больше 500 МБ — обработка в браузере будет очень долгой");
        return;
      }
      onFile(f);
    },
    [onError, onFile],
  );

  const makeDemo = async () => {
    if (demo > 0) return;
    setDemo(1);
    try {
      const res = await generateDemoVideo((p) => setDemo(Math.max(1, Math.round(p))));
      onFile(new File([res.blob], res.name, { type: res.blob.type }));
    } catch (e) {
      console.error(e);
      onError("Не удалось сгенерировать демо-видео в этом браузере");
      setDemo(0);
    }
  };

  return (
    <div className="fade-up mx-auto w-full max-w-5xl px-5">
      <div className="grid items-start gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        {/* левая колонка — зона загрузки */}
        <div>
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-ink-600 bg-ink-850/80 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-mist-400">
            <ShieldCheck size={13} className="text-ok-400" />
            100% локально · видео не покидает устройство
          </div>
          <h2 className="font-display text-3xl font-bold leading-tight tracking-tight text-mist-100 sm:text-4xl">
            Уберите знак —<br />
            <span className="text-rec-400">фон восстановится сам</span>
          </h2>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-mist-400">
            Выделите логотип прямоугольником или закрасьте кистью — удаляется вся выделенная область.
            Каждый кадр восстанавливается настоящим{" "}
            <span className="text-mist-200">inpainting-алгоритмом Telea</span>{" "}
            <span className="font-mono text-[13px] text-mist-400">(Fast Marching)</span> в полном
            разрешении. Без размытых пятен, без сервера, со звуком.
          </p>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              take(e.dataTransfer.files?.[0]);
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
            className={`focus-ring group mt-7 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-all ${
              over ? "drop-active" : "border-ink-600 bg-ink-850/60 hover:border-mark-500/60 hover:bg-ink-850"
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                take(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <div className="grid h-16 w-16 place-items-center rounded-2xl border border-ink-600 bg-ink-800 text-mark-400 transition-transform group-hover:-translate-y-1 group-hover:scale-105">
              <Upload size={26} strokeWidth={2.2} />
            </div>
            <div className="mt-5 text-[17px] font-semibold text-mist-100">
              Перетащите видео сюда <span className="text-mist-500">или</span>{" "}
              <span className="text-mark-400 underline decoration-mark-500/50 underline-offset-4">выберите файл</span>
            </div>
            <div className="mt-2 font-mono text-[12px] text-mist-500">MP4 · WebM · до 500 МБ</div>
          </div>

          <button
            onClick={makeDemo}
            disabled={demo > 0}
            className="focus-ring mt-4 inline-flex items-center gap-2.5 rounded-xl border border-ink-600 bg-ink-850/80 px-5 py-3 text-[14px] font-semibold text-mist-200 transition hover:border-mark-500/60 hover:text-mark-300 active:scale-[0.97] disabled:opacity-60"
          >
            {demo > 0 ? <Loader2 size={17} className="animate-spin text-mark-400" /> : <Clapperboard size={17} className="text-mark-400" />}
            {demo > 0 ? `Рендерим демо… ${demo}%` : "Сгенерировать демо-видео со знаком"}
          </button>
        </div>

        {/* правая колонка — как это работает */}
        <aside className="rounded-2xl border border-ink-700 bg-ink-850/70 p-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-mist-500">Как это работает</div>
          <ol className="mt-4 space-y-4">
            {[
              ["01", "Выделяете знак", "Прямоугольник с запасом или точная кисть — мышью либо пальцем. Всё, что выделено, будет удалено."],
              ["02", "Превью на кадре", "Один клик — и вы видите восстановленный кадр до запуска обработки."],
              ["03", "Telea inpainting", "Каждый кадр восстанавливается волновым алгоритмом Fast Marching в полном разрешении — структура фона продолжается, знак исчезает."],
              ["04", "Реальный файл", "H.264/VP9 + оригинальная аудиодорожка (AAC/Opus), точный FPS, без пропусков кадров."],
            ].map(([num, title, text]) => (
              <li key={num} className="flex gap-3.5">
                <span className="mt-0.5 h-fit shrink-0 rounded-md border border-mark-500/40 bg-mark-500/10 px-2 py-1 font-mono text-[11px] font-bold text-mark-400">
                  {num}
                </span>
                <div>
                  <div className="text-[14px] font-semibold text-mist-100">{title}</div>
                  <div className="mt-0.5 text-[12.5px] leading-relaxed text-mist-400">{text}</div>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-ink-700 pt-4 font-mono text-[11px] text-mist-500">
            <span className="inline-flex items-center gap-1.5">
              <Cpu size={13} className="text-mark-400" /> Telea FMM · локальный движок
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Volume2 size={13} className="text-mark-400" /> звук сохраняется
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FileVideo size={13} className="text-mark-400" /> исходное разрешение
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
