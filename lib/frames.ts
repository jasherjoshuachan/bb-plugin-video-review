// Frame truth for Video Review.
//
// A note's position is a 0-based frame index into one exact file (its sha256).
// Seconds and timecode are derived for display only. The browser reports the
// presented frame's time (requestVideoFrameCallback mediaTime) on the file's
// own timeline, so we map it through the file's real presentation timestamps
// instead of multiplying by fps; that keeps start offsets and variable frame
// rate files right.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Rational {
  num: number;
  den: number;
}

export interface FrameIndex {
  sha256: string;
  width: number;
  height: number;
  /** Nominal rate from the stream (r_frame_rate), exact rational. */
  fps: Rational;
  /** True when frame spacing varies by more than a tenth of a frame. */
  vfr: boolean;
  /** Container start_time in seconds; ffmpeg input seeks count from here. */
  formatStart: number;
  /** Presentation time of each frame in display order, seconds, file timeline. */
  pts: number[];
}

export interface Tools {
  ffprobe: string;
  ffmpeg: string;
}

export const defaultTools: Tools = {
  ffprobe: "ffprobe",
  ffmpeg: "ffmpeg",
};

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function parseRational(text: string | undefined): Rational {
  const [n, d] = String(text ?? "0/1").split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return { num: 0, den: 1 };
  return { num: n, den: d };
}

export async function probeFrames(
  path: string,
  tools: Tools = defaultTools,
  sha256?: string,
): Promise<FrameIndex> {
  const { stdout } = await run(
    tools.ffprobe,
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,time_base:packet=pts:format=start_time",
      "-of", "json",
      path,
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  if (!stream) throw new Error(`No video stream in ${path}`);
  const tb = parseRational(stream.time_base);
  // Packets arrive in decode order; sorting the integer pts gives display order.
  const ticks: number[] = (data.packets ?? [])
    .map((p: { pts?: string | number }) => Number(p.pts))
    .filter((v: number) => Number.isFinite(v))
    .sort((a: number, b: number) => a - b);
  if (ticks.length === 0) throw new Error(`No video frames in ${path}`);
  const pts = ticks.map((t) => (t * tb.num) / tb.den);
  const fps = parseRational(stream.r_frame_rate);
  const frameDur = fps.num > 0 ? fps.den / fps.num : 0;
  let vfr = false;
  for (let i = 1; i < pts.length && frameDur > 0; i++) {
    if (Math.abs(pts[i] - pts[i - 1] - frameDur) > frameDur / 10) {
      vfr = true;
      break;
    }
  }
  return {
    sha256: sha256 ?? (await sha256File(path)),
    width: Number(stream.width),
    height: Number(stream.height),
    fps,
    vfr,
    formatStart: Number(data.format?.start_time ?? 0) || 0,
    pts,
  };
}

/** Frame shown at file time t: the last frame whose pts is at or before t. */
export function frameAtTime(index: FrameIndex, t: number): number {
  const { pts } = index;
  const eps = 1e-4;
  if (t < pts[0] - eps) return 0;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid] <= t + eps) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Time to assign to video.currentTime to show frame n. Browsers show the frame
 * at or before the seek time, and a seek exactly on a boundary can land on the
 * previous frame, so nudge a little into the frame (Kitsu does the same).
 */
export function seekTimeForFrame(index: FrameIndex, n: number): number {
  const { pts } = index;
  const i = clampFrame(index, n);
  const next = i + 1 < pts.length ? pts[i + 1] : pts[i] + frameDuration(index);
  return pts[i] + Math.min(0.001, (next - pts[i]) / 4);
}

export function clampFrame(index: FrameIndex, n: number): number {
  return Math.max(0, Math.min(index.pts.length - 1, Math.trunc(n)));
}

export function frameDuration(index: FrameIndex): number {
  return index.fps.num > 0 ? index.fps.den / index.fps.num : 1 / 30;
}

/** Non-drop timecode HH:MM:SS:FF on the nominal rate, from the frame index. */
export function timecode(index: FrameIndex, n: number): string {
  const base = Math.max(1, Math.round(index.fps.num / index.fps.den || 30));
  const f = clampFrame(index, n);
  const ff = f % base;
  const totalSeconds = Math.floor(f / base);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(ff)}`;
}

/** Version-stamped label, Kitsu style: `v7 00:01:12:17 (2177)`. */
export function frameLabel(index: FrameIndex, n: number, version?: string): string {
  const tc = `${timecode(index, n)} (${clampFrame(index, n)})`;
  return version ? `${version} ${tc}` : tc;
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * ffmpeg arguments that write frame n as a PNG. Input seeking lands on the
 * first frame at or after the seek point (relative to the container start),
 * so seek just before the frame's own pts. Checked against select=eq(n,N).
 */
export function stillArgs(index: FrameIndex, path: string, n: number, out: string, crop?: Crop): string[] {
  const { pts } = index;
  const i = clampFrame(index, n);
  const prevGap = i > 0 ? pts[i] - pts[i - 1] : 0.002;
  const seek = Math.max(0, pts[i] - index.formatStart - Math.min(prevGap / 2, 0.001));
  const vf = crop ? ["-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : [];
  return [
    "-v", "error",
    "-ss", seek.toFixed(6),
    "-i", path,
    "-map", "0:v:0",
    "-frames:v", "1",
    ...vf,
    "-y", out,
  ];
}

export async function extractStill(
  index: FrameIndex,
  path: string,
  n: number,
  out: string,
  options: { crop?: Crop; tools?: Tools } = {},
): Promise<void> {
  await run((options.tools ?? defaultTools).ffmpeg, stillArgs(index, path, n, out, options.crop));
}
