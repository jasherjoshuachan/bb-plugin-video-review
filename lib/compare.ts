// Pixel compare of one frame from each of two renders (Ziflow's Auto Compare,
// RV's difference view, done on the server so the numbers are exact).
//
// Both frames are decoded at full resolution with the same seek rule as the
// stills, compared per pixel, and written as three PNGs: frame A, frame B,
// and the difference amplified so small shifts show. The numbers say how
// much changed and where: the bounding box of pixels that differ by more
// than a threshold is what turns "the inset moved" into coordinates.
import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { stillArgs, type FrameIndex, type Tools } from "./frames.ts";

const run = promisify(execFile);

export interface PixelDiff {
  width: number;
  height: number;
  /** Mean absolute difference over all channels, 0-255. */
  mean: number;
  /** Largest single-channel difference, 0-255. */
  max: number;
  /** Share of pixels whose largest channel difference exceeds the threshold. */
  changedShare: number;
  /** Bounding box of those pixels in source pixels, or null when nothing changed. */
  box: { x: number; y: number; w: number; h: number } | null;
  threshold: number;
}

/** Pure: compares two rgb24 buffers of the same size and fills an amplified gray difference image. */
export function diffRgb(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  threshold = 24,
  gain = 4,
): { diff: PixelDiff; image: Uint8Array } {
  if (a.length !== width * height * 3 || b.length !== a.length) throw new Error("Frames differ in size.");
  const image = new Uint8Array(width * height);
  let sum = 0;
  let max = 0;
  let changed = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let p = 0, q = 0; q < image.length; p += 3, q++) {
    const dr = Math.abs(a[p] - b[p]);
    const dg = Math.abs(a[p + 1] - b[p + 1]);
    const db = Math.abs(a[p + 2] - b[p + 2]);
    sum += dr + dg + db;
    const big = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
    if (big > max) max = big;
    image[q] = Math.min(255, big * gain);
    if (big > threshold) {
      changed++;
      const x = q % width;
      const y = (q - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return {
    diff: {
      width,
      height,
      mean: Math.round((sum / (image.length * 3)) * 100) / 100,
      max,
      changedShare: Math.round((changed / image.length) * 10000) / 10000,
      box: x1 >= 0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null,
      threshold,
    },
    image,
  };
}

async function rawFrame(index: FrameIndex, file: string, frame: number, tools: Tools): Promise<Uint8Array> {
  const args = stillArgs(index, file, frame, "-");
  const outAt = args.indexOf("-y");
  const { stdout } = await run(tools.ffmpeg, [...args.slice(0, outAt), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    encoding: "buffer",
    maxBuffer: index.width * index.height * 3 + 1024,
  });
  return new Uint8Array(stdout);
}

function writeGrayPng(tools: Tools, image: Uint8Array, width: number, height: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, [
      "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${width}x${height}`, "-i", "-",
      "-frames:v", "1", "-y", out,
    ]);
    let err = "";
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
    child.stdin.end(Buffer.from(image.buffer, image.byteOffset, image.byteLength));
  });
}

export interface FrameCompare {
  diff: PixelDiff;
  files: { a: string; b: string; difference: string };
}

/** Compares frame `frameA` of file A with frame `frameB` of file B; writes PNGs under `dir`. */
export async function compareFrames(
  a: { index: FrameIndex; file: string; frame: number },
  b: { index: FrameIndex; file: string; frame: number },
  dir: string,
  tools: Tools,
): Promise<FrameCompare> {
  if (a.index.width !== b.index.width || a.index.height !== b.index.height) {
    throw new Error(
      `The renders differ in size (${a.index.width}x${a.index.height} and ${b.index.width}x${b.index.height}); pixel compare needs the same size.`,
    );
  }
  await mkdir(dir, { recursive: true });
  const [ra, rb] = await Promise.all([rawFrame(a.index, a.file, a.frame, tools), rawFrame(b.index, b.file, b.frame, tools)]);
  const { diff, image } = diffRgb(ra, rb, a.index.width, a.index.height);
  const stem = `${a.index.sha256.slice(0, 12)}-${a.frame}-vs-${b.index.sha256.slice(0, 12)}-${b.frame}`;
  const files = {
    a: path.join(dir, `${stem}-a.png`),
    b: path.join(dir, `${stem}-b.png`),
    difference: path.join(dir, `${stem}-diff.png`),
  };
  await Promise.all([
    run(tools.ffmpeg, stillArgs(a.index, a.file, a.frame, files.a)),
    run(tools.ffmpeg, stillArgs(b.index, b.file, b.frame, files.b)),
    writeGrayPng(tools, image, a.index.width, a.index.height, files.difference),
  ]);
  return { diff, files };
}
