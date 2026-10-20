// Keeping old renders viewable, and the tiny frame signatures used to align
// two renders.
//
// A render is usually written over the same path, so the file a note was
// written on is gone after the next render. When a version is first seen, a
// copy-on-write clone (`cp -c`, APFS) is kept in the plugin's data folder; it
// costs no disk space until the original is rewritten. Where cloning is not
// possible a plain copy is made only below a size limit. A snapshot is
// deleted only when no open note needs it.
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, rm, stat, copyFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sha256File, type Tools } from "./frames.ts";
import type { Signatures } from "./align.ts";
import type { NoteStatus } from "./types.ts";

const run = promisify(execFile);

export type Kept = "clone" | "copy" | "none" | "pruned";

/** Statuses that still need the version they were written on. */
export const OPEN_STATUSES: readonly NoteStatus[] = ["draft", "sent", "fixed", "question"];

export const SIGNATURE_WIDTH = 32;
export const SIGNATURE_HEIGHT = 18;
export const SIGNATURE_SIZE = SIGNATURE_WIDTH * SIGNATURE_HEIGHT;

export function snapshotPath(dir: string, sha256: string): string {
  return path.join(dir, "versions", `${sha256}.mp4`);
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/**
 * Keeps a copy of `source` as `versions/<sha>.mp4`. Clones first; copies only
 * when the file is at most `maxCopyBytes`. The copy is checked against the
 * sha so a file rewritten mid-copy is never kept under the wrong name.
 */
export async function keepSnapshot(
  source: string,
  sha256: string,
  dir: string,
  maxCopyBytes: number,
): Promise<{ kept: Kept; path: string | null; reason?: string }> {
  const target = snapshotPath(dir, sha256);
  if (await exists(target)) return { kept: "clone", path: target };
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  let kept: Kept = "clone";
  try {
    await run("/bin/cp", ["-c", source, temp]);
  } catch {
    const size = (await stat(source)).size;
    if (size > maxCopyBytes) {
      return { kept: "none", path: null, reason: `cloning is not possible here and the file (${Math.round(size / 1e6)} MB) is over the copy limit` };
    }
    await copyFile(source, temp);
    kept = "copy";
  }
  const actual = await sha256File(temp).catch(() => null);
  if (actual !== sha256) {
    await rm(temp, { force: true });
    return { kept: "none", path: null, reason: "the file changed while it was being kept" };
  }
  await rename(temp, target);
  return { kept, path: target };
}

export async function dropSnapshot(dir: string, sha256: string): Promise<void> {
  await rm(snapshotPath(dir, sha256), { force: true });
}

export interface VersionUse {
  sha256: string;
  /** Order first seen, 0-based. */
  order: number;
  kept: Kept;
}

/**
 * Which kept snapshots can go: not the file on disk now, not the version
 * before it (so a re-render can always be compared with the last one), not
 * any version an open note was written on or fixed in.
 */
export function snapshotsToPrune(
  versions: readonly VersionUse[],
  notes: ReadonlyArray<{ mediaSha256: string; fixedInSha: string | null; status: NoteStatus }>,
  currentSha: string | null,
): string[] {
  const keep = new Set<string>();
  if (currentSha) keep.add(currentSha);
  const ordered = [...versions].sort((a, b) => a.order - b.order);
  const currentIndex = currentSha ? ordered.findIndex((v) => v.sha256 === currentSha) : ordered.length;
  const previous = ordered[(currentIndex < 0 ? ordered.length : currentIndex) - 1];
  if (previous) keep.add(previous.sha256);
  for (const note of notes) {
    if (!OPEN_STATUSES.includes(note.status)) continue;
    keep.add(note.mediaSha256);
    if (note.fixedInSha) keep.add(note.fixedInSha);
  }
  return ordered.filter((v) => (v.kept === "clone" || v.kept === "copy") && !keep.has(v.sha256)).map((v) => v.sha256);
}

/** Tiny grayscale frames of every frame, cached as `signatures/<sha>.bin`. */
export async function signatures(file: string, sha256: string, frames: number, dir: string, tools: Tools): Promise<Signatures> {
  const out = path.join(dir, "signatures", `${sha256}-${SIGNATURE_WIDTH}x${SIGNATURE_HEIGHT}.bin`);
  if (!(await exists(out))) {
    await mkdir(path.dirname(out), { recursive: true });
    const temp = `${out}.${process.pid}.${Date.now()}.tmp`;
    await run(
      tools.ffmpeg,
      [
        "-v", "error",
        "-threads", "0",
        "-i", file,
        "-map", "0:v:0",
        "-fps_mode", "passthrough",
        "-vf", `scale=${SIGNATURE_WIDTH}:${SIGNATURE_HEIGHT}:flags=area,format=gray`,
        "-f", "rawvideo",
        "-y", temp,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    await rename(temp, out);
  }
  const data = new Uint8Array(await readFile(out));
  const count = data.length / SIGNATURE_SIZE;
  if (!Number.isInteger(count) || Math.abs(count - frames) > 2) {
    await rm(out, { force: true });
    throw new Error(`Frame signatures came out as ${count} frames, the video has ${frames}.`);
  }
  return { count, size: SIGNATURE_SIZE, data };
}
