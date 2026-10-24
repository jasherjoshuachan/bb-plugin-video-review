// The scrubber: a timeline strip to skim a render the way an editor does (issue get-bb/bb#6039).
//
// Node side, per file version (cached by sha256 in the plugin's data folder):
//   - thumbnail sheets (one tile every `step` seconds, 10 x 10 tiles a sheet), and in the same decode the black frames (blackdetect);
//   - a small proxy with a keyframe every 5 frames, so hover skimming seeks at once; the full render plays when the playhead is parked.
// The settings are the studio scrub page's (cyndra-studio scripts/scrub.py), which already proved them on real renders.
// Pure math (tiles, zoom, pan, scene cuts) is shared with the tab.
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Tools } from "./frames.ts";

const run = promisify(execFile);

import { COLS, ROWS, SCRUB_FORMAT, THUMB_W, thumbStep, parseBlack, type ScrubMeta } from "./scrub-math.ts";
export * from "./scrub-math.ts";

// ---------------------------------------------------------------- building the files

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

/**
 * Builds (or reads back) the scrubber files of one version into `dir`. `info` is the file's own probe.
 * Written to a temporary folder and renamed, so a half-built cache is never read.
 */
export async function buildScrub(
  tools: Tools,
  absPath: string,
  dir: string,
  info: { sha256: string; duration: number; width: number; height: number },
): Promise<ScrubMeta> {
  const metaFile = path.join(dir, "meta.json");
  if (await exists(metaFile)) {
    const meta = JSON.parse(await readFile(metaFile, "utf8")) as ScrubMeta;
    if (meta.format === SCRUB_FORMAT && meta.sha256 === info.sha256) return meta;
  }
  const tmp = `${dir}.part-${process.pid}-${Date.now()}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    const step = thumbStep(info.duration);
    const th = Math.round((THUMB_W * info.height) / info.width / 2) * 2;
    const sheets = await run(
      tools.ffmpeg,
      [
        "-v", "info", "-nostats", "-nostdin", "-y", "-i", absPath,
        "-filter_complex",
        `[0:v]split[a][b];[a]fps=1/${step},scale=${THUMB_W}:${th},tile=${COLS}x${ROWS}[s];[b]blackdetect=d=0:pix_th=0.1,nullsink`,
        "-map", "[s]", "-q:v", "4", path.join(tmp, "sheet-%03d.jpg"),
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const black = parseBlack(String(sheets.stderr));
    const pw = Math.floor(Math.min(960, info.width) / 2) * 2;
    await run(
      tools.ffmpeg,
      [
        "-v", "error", "-nostdin", "-y", "-i", absPath, "-an", "-vf", `scale=${pw}:-2`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "5", "-keyint_min", "5", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(tmp, "proxy.mp4"),
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const files = (await readdir(tmp)).filter((f) => /^sheet-\d+\.jpg$/.test(f)).sort();
    const meta: ScrubMeta = {
      format: SCRUB_FORMAT,
      sha256: info.sha256,
      step,
      count: Math.ceil(info.duration / step),
      cols: COLS,
      rows: ROWS,
      w: THUMB_W,
      h: th,
      sheets: files,
      black,
      proxy: "proxy.mp4",
    };
    await writeFile(path.join(tmp, "meta.json"), JSON.stringify(meta));
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    return meta;
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}
