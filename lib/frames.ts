// Frame truth for Video Review, Node side: hashing, probing the presentation
// timestamps, and still extraction. The pure math lives in frame-math.ts so
// the player can share it.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  clampFrame,
  type Crop,
  type FrameIndex,
  type Rational,
} from "./frame-math.ts";

export * from "./frame-math.ts";

const run = promisify(execFile);

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

/**
 * ffmpeg arguments that write frame n as a PNG. Input seeking lands on the
 * first frame at or after the seek point (relative to the container start),
 * so seek just before the frame's own pts. Checked against select=eq(n,N).
 */
export function stillArgs(
  index: FrameIndex,
  path: string,
  n: number,
  out: string,
  crop?: Crop,
  filters: string[] = [],
): string[] {
  const { pts } = index;
  const i = clampFrame(index, n);
  const prevGap = i > 0 ? pts[i] - pts[i - 1] : 0.002;
  const seek = Math.max(0, pts[i] - index.formatStart - Math.min(prevGap / 2, 0.001));
  const chain = [...filters, ...(crop ? [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : [])];
  const vf = chain.length > 0 ? ["-vf", chain.join(",")] : [];
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
  options: { crop?: Crop; filters?: string[]; tools?: Tools } = {},
): Promise<void> {
  await run(
    (options.tools ?? defaultTools).ffmpeg,
    stillArgs(index, path, n, out, options.crop, options.filters ?? []),
  );
}
