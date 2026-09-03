// Генерация демо-видео «со съёмки дрона»: движущийся градиент неба, солнце,
// плывущие облака, чайки, зерно — и полупрозрачный водяной знак. Плюс
// синтезированная звуковая дорожка (WebAudio → MediaRecorder), чтобы можно
// было проверить и удаление знака, и сохранение звука.

export interface DemoBlob {
  blob: Blob;
  name: string;
  ext: "mp4" | "webm";
}

export async function generateDemoVideo(
  onProgress: (pct: number) => void,
): Promise<DemoBlob> {
  const W = 1280;
  const H = 720;
  const DUR = 6;
  const FPS = 30;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // зерно — заранее нарисованные тайлы шума
  const tiles: HTMLCanvasElement[] = [];
  for (let t = 0; t < 8; t++) {
    const tc = document.createElement("canvas");
    tc.width = 160;
    tc.height = 120;
    const tctx = tc.getContext("2d")!;
    const id = tctx.createImageData(160, 120);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = 118 + Math.floor(Math.random() * 30);
      id.data[i] = v;
      id.data[i + 1] = v;
      id.data[i + 2] = v;
      id.data[i + 3] = 255;
    }
    tctx.putImageData(id, 0, 0);
    tiles.push(tc);
  }

  const clouds = Array.from({ length: 6 }, (_, i) => ({
    x: Math.random() * W,
    y: 60 + Math.random() * 300,
    s: 0.7 + Math.random() * 1.6,
    v: 12 + Math.random() * 26,
    a: 0.25 + Math.random() * 0.3,
    seed: i,
  }));

  const draw = (t: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    const sh = Math.sin(t * 0.6) * 10;
    sky.addColorStop(0, `hsl(${211 + sh} 64% ${52 + sh / 2}%)`);
    sky.addColorStop(0.65, `hsl(${203 + sh} 58% ${66 + sh / 2}%)`);
    sky.addColorStop(1, `hsl(${36} 74% ${80 + sh / 3}%)`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    const sx = W * 0.72 + Math.sin(t * 0.3) * 30;
    const sy = H * 0.26 + Math.cos(t * 0.23) * 14;
    const sun = ctx.createRadialGradient(sx, sy, 4, sx, sy, 210);
    sun.addColorStop(0, "rgba(255,250,220,0.95)");
    sun.addColorStop(0.12, "rgba(255,236,170,0.8)");
    sun.addColorStop(0.5, "rgba(255,220,140,0.22)");
    sun.addColorStop(1, "rgba(255,220,140,0)");
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, W, H);

    for (const c of clouds) {
      const x = ((c.x + c.v * t) % (W + 500)) - 250;
      const y = c.y + Math.sin(t * 0.5 + c.seed) * 8;
      ctx.save();
      ctx.globalAlpha = c.a;
      ctx.fillStyle = "#ffffff";
      for (let k = 0; k < 5; k++) {
        const rx = x + k * 34 * c.s;
        const ry = y + ((k * 53 + c.seed * 31) % 26) - 13;
        const rr = (26 + ((k * 37 + c.seed * 17) % 26)) * c.s;
        ctx.beginPath();
        ctx.ellipse(rx, ry, rr * 1.5, rr * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.strokeStyle = "rgba(30,40,60,0.55)";
    ctx.lineWidth = 2.4;
    for (let b = 0; b < 3; b++) {
      const bx = ((t * (40 + b * 18) + b * 420) % (W + 200)) - 100;
      const by = 130 + b * 70 + Math.sin(t * 2.2 + b * 2) * 12;
      const fl = Math.sin(t * 9 + b * 3) * 7;
      ctx.beginPath();
      ctx.moveTo(bx - 16, by - fl);
      ctx.quadraticCurveTo(bx - 6, by + 6, bx, by);
      ctx.quadraticCurveTo(bx + 6, by + 6, bx + 16, by - fl);
      ctx.stroke();
    }

    // лёгкое «дыхание» камеры
    ctx.save();
    ctx.globalAlpha = 0.05;
    const tile = tiles[Math.floor(t * 8) % tiles.length];
    for (let y = 0; y < H; y += 120) {
      for (let x = 0; x < W; x += 160) {
        ctx.drawImage(tile, x, y);
      }
    }
    ctx.restore();

    // водяной знак
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.textAlign = "right";
    ctx.font = "700 34px 'Segoe UI', Arial, sans-serif";
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText("PIXELSTOCK", W - 30, H - 58);
    ctx.font = "500 20px 'Segoe UI', Arial, sans-serif";
    ctx.fillText("© 2026 · лицензия trial", W - 30, H - 28);
    ctx.restore();
  };

  // ---------- аудио: мягкий ветер + бипы ----------
  let AC: typeof AudioContext = window.AudioContext;
  if (!AC) {
    AC = (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  }
  const actx = new AC();
  await actx.resume().catch(() => undefined);
  const dest = actx.createMediaStreamDestination();

  const noiseBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < nd.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    nd[i] = last * 3.2;
  }
  const wind = actx.createBufferSource();
  wind.buffer = noiseBuf;
  wind.loop = true;
  const windGain = actx.createGain();
  windGain.gain.value = 0.05;
  const lp = actx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 420;
  wind.connect(lp).connect(windGain).connect(dest);
  wind.start();

  const notes = [523.25, 659.25, 783.99, 659.25, 587.33, 659.25, 880.0, 783.99];
  const t0 = actx.currentTime + 0.1;
  notes.forEach((f, i) => {
    const o = actx.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    const gp = actx.createGain();
    const s = t0 + i * 0.62;
    gp.gain.setValueAtTime(0, s);
    gp.gain.linearRampToValueAtTime(0.16, s + 0.04);
    gp.gain.exponentialRampToValueAtTime(0.001, s + 0.5);
    o.connect(gp).connect(dest);
    o.start(s);
    o.stop(s + 0.55);
  });

  // ---------- запись ----------
  const stream = canvas.captureStream(FPS);
  for (const at of dest.stream.getAudioTracks()) stream.addTrack(at);

  const mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find(
    (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m),
  );
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((res) => {
    rec.onstop = () => res();
  });

  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      draw(t);
      onProgress(Math.min(100, (t / DUR) * 100));
      if (t >= DUR) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  rec.start();
  await new Promise((r) => setTimeout(r, 200));
  rec.stop();
  await stopped;
  wind.stop();
  await actx.close().catch(() => undefined);

  const ext: "mp4" | "webm" = mime?.includes("mp4") ? "mp4" : "webm";
  return {
    blob: new Blob(chunks, { type: mime ?? "video/webm" }),
    name: `demo-stock-footage.${ext}`,
    ext,
  };
}
