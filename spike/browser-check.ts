// Spike: does the frame the browser shows equal the frame the server extracts?
//
// For each picked frame n: seek a <video> to seekTimeForFrame(n), read the
// presented frame's mediaTime from requestVideoFrameCallback, map it through
// frameAtTime, and compare the canvas pixels with ffmpeg's frames n-1, n, n+1.
// Then play a stretch and check every presented mediaTime lands on a real pts.
//
// Usage: node spike/browser-check.ts <video.mp4> [count] [--frames a,b,c]
// Env: PUPPETEER_CORE (path to puppeteer-core), CHROME (browser binary).

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { createRequire } from "node:module";
import { frameAtTime, probeFrames, seekTimeForFrame, type FrameIndex } from "../lib/frames.ts";

const file = process.argv[2];
const count = Number(process.argv[3] ?? 40);
const framesArg = process.argv.indexOf("--frames");
const extra = framesArg > 0 ? process.argv[framesArg + 1].split(",").map(Number) : [];
const W = Number(process.env.VR_W ?? 960);
const H = Number(process.env.VR_H ?? 540);

const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE!);

function serve(path: string): Promise<{ url: string; close: () => void }> {
  const size = statSync(path).size;
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body></body></html>");
      return;
    }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : size - 1;
    res.writeHead(range ? 206 : 200, {
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
      ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    });
    createReadStream(path, { start, end }).pipe(res);
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}

function ffmpegFrame(index: FrameIndex, n: number): Buffer {
  const { pts } = index;
  const prevGap = n > 0 ? pts[n] - pts[n - 1] : 0.002;
  const seek = Math.max(0, pts[n] - index.formatStart - Math.min(prevGap / 2, 0.001));
  return execFileSync("ffmpeg", [
    "-v", "error", "-ss", seek.toFixed(6), "-i", file, "-map", "0:v:0", "-frames:v", "1",
    "-vf", `scale=${W}:${H}:flags=bilinear`, "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });
}

function meanDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    k += 3;
  }
  return sum / k;
}

const index = await probeFrames(file);
const total = index.pts.length;
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const picks = [...new Set([0, 1, total - 1, ...extra, ...Array.from({ length: count }, () => 1 + Math.floor(rand() * (total - 2)))])]
  .filter((n) => n >= 0 && n < total)
  .sort((a, b) => a - b);

const { url, close } = await serve(file);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
const page = await browser.newPage();
await page.goto(url + "/");
await page.evaluate(async (src: string, w: number, h: number) => {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = src;
  document.body.appendChild(v);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  (window as any).__v = v;
  (window as any).__c = c.getContext("2d", { willReadFrequently: true });
  await new Promise((ok, fail) => {
    v.addEventListener("loadeddata", ok, { once: true });
    v.addEventListener("error", () => fail(new Error(String(v.error?.message))), { once: true });
  });
}, url + "/" + encodeURIComponent(basename(file)), W, H);

const results: Array<Record<string, unknown>> = [];
let mapOk = 0;
let pixelOk = 0;
let pixelJudged = 0;
for (const n of picks) {
  const seekTo = seekTimeForFrame(index, n);
  const shot = await page.evaluate(async (t: number, w: number, h: number) => {
    const v = (window as any).__v as HTMLVideoElement;
    const ctx = (window as any).__c as CanvasRenderingContext2D;
    const presented = new Promise<number>((ok) => v.requestVideoFrameCallback((_now, md) => ok(md.mediaTime)));
    const seeked = new Promise((ok) => v.addEventListener("seeked", ok, { once: true }));
    v.currentTime = t;
    await seeked;
    const mediaTime = await Promise.race([presented, new Promise<number>((ok) => setTimeout(() => ok(-1), 2000))]);
    ctx.drawImage(v, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return { mediaTime, currentTime: v.currentTime, rgba: btoa(bin) };
  }, seekTo, W, H);

  const shown = shot.mediaTime >= 0 ? frameAtTime(index, shot.mediaTime) : -1;
  if (shown === n) mapOk++;
  const canvas = Buffer.from(shot.rgba, "base64");
  const diffs: Record<number, number> = {};
  for (const k of [n - 1, n, n + 1]) if (k >= 0 && k < total) diffs[k] = meanDiff(canvas, ffmpegFrame(index, k));
  // Judge pixels only where the neighbours really differ from frame n.
  const neighbours = [n - 1, n + 1].filter((k) => k in diffs);
  const nearest = Object.entries(diffs).sort((a, b) => a[1] - b[1])[0];
  const distinct = neighbours.every((k) => meanDiff(ffmpegFrame(index, k), ffmpegFrame(index, n)) > 0.05);
  if (distinct) {
    pixelJudged++;
    if (Number(nearest[0]) === n) pixelOk++;
  }
  results.push({ n, seekTo: +seekTo.toFixed(6), mediaTime: shot.mediaTime, shown, nearestByPixels: Number(nearest[0]), distinct, diffs });
}

// Playback: every presented mediaTime should sit on a real pts.
const startFrame = Math.min(total - 120, Math.floor(total / 3));
const play = await page.evaluate(async (t: number) => {
  const v = (window as any).__v as HTMLVideoElement;
  v.currentTime = t;
  await new Promise((ok) => v.addEventListener("seeked", ok, { once: true }));
  const seen: Array<[number, number]> = [];
  await new Promise<void>((ok) => {
    const cb = (_now: number, md: VideoFrameCallbackMetadata) => {
      seen.push([md.mediaTime, md.presentedFrames]);
      if (seen.length < 90) v.requestVideoFrameCallback(cb);
      else { v.pause(); ok(); }
    };
    v.requestVideoFrameCallback(cb);
    v.play();
    setTimeout(() => { v.pause(); ok(); }, 10000);
  });
  return seen;
}, seekTimeForFrame(index, startFrame));
const offPts = (play as Array<[number, number]>).filter(([mt]) => Math.abs(index.pts[frameAtTime(index, mt)] - mt) > 0.0005).length;

await browser.close();
close();

const summary = {
  file: basename(file),
  frames: total,
  fps: `${index.fps.num}/${index.fps.den}`,
  vfr: index.vfr,
  formatStart: index.formatStart,
  firstPts: index.pts[0],
  checked: picks.length,
  seekMapsToFrame: `${mapOk}/${picks.length}`,
  pixelsNearestIsFrame: `${pixelOk}/${pixelJudged} (judged where neighbours differ)`,
  playbackMediaTimesOnPts: `${play.length - offPts}/${play.length}`,
  misses: results.filter((r) => r.shown !== r.n || (r.distinct && r.nearestByPixels !== r.n)),
};
console.log(JSON.stringify(summary, null, 2));
