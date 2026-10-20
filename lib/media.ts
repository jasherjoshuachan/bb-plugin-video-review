// Probing and stills on the bb server's machine, cached by file identity.
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { cropFor, shapeFilters } from "./annotate.ts";
import { extractStill, probeFrames, type FrameIndex, type Tools } from "./frames.ts";
import type { PixelRect, Shape } from "./types.ts";

const PROBE_CACHE_MAX = 32;

export interface Stills {
  raw: string;
  annotated: string | null;
  crop: string | null;
}

export class VideoMedia {
  private readonly tools: () => Promise<Tools>;
  private readonly stillsDir: string;
  private readonly probes = new Map<string, Promise<FrameIndex>>();

  constructor(tools: () => Promise<Tools>, stillsDir: string) {
    this.tools = tools;
    this.stillsDir = stillsDir;
  }

  /** The frame index of the file as it is now; re-probed when its size or mtime changes. */
  async index(absPath: string): Promise<FrameIndex> {
    const info = await stat(absPath).catch(() => null);
    if (!info?.isFile()) throw new Error(`The video is gone: ${absPath}`);
    const key = `${absPath}\u0000${info.size}\u0000${Math.round(info.mtimeMs)}`;
    let pending = this.probes.get(key);
    if (!pending) {
      pending = this.tools().then((tools) => probeFrames(absPath, tools));
      this.probes.set(key, pending);
      pending.catch(() => this.probes.delete(key));
      while (this.probes.size > PROBE_CACHE_MAX) {
        const oldest = this.probes.keys().next().value;
        if (oldest === undefined) break;
        this.probes.delete(oldest);
      }
    }
    return pending;
  }

  /** sha256 of the file on disk now, or null when it is gone. */
  async currentSha(absPath: string): Promise<string | null> {
    try {
      return (await this.index(absPath)).sha256;
    } catch {
      return null;
    }
  }

  /** Stills frozen for a note when it is written: the frame, the marked-up frame, and a crop. */
  async noteStills(
    noteId: string,
    absPath: string,
    index: FrameIndex,
    frame: number,
    shapes: readonly Shape[],
    rect: PixelRect | null,
  ): Promise<Stills> {
    await mkdir(this.stillsDir, { recursive: true });
    const tools = await this.tools();
    const raw = path.join(this.stillsDir, `${noteId}-raw.png`);
    await extractStill(index, absPath, frame, raw, { tools });
    const marks = shapeFilters(shapes, index.width, index.height);
    let annotated: string | null = null;
    if (marks.length > 0) {
      annotated = path.join(this.stillsDir, `${noteId}-annotated.png`);
      await extractStill(index, absPath, frame, annotated, { tools, filters: marks });
    }
    const area = cropFor(rect, shapes, index.width, index.height);
    let crop: string | null = null;
    if (area) {
      crop = path.join(this.stillsDir, `${noteId}-crop.png`);
      await extractStill(index, absPath, frame, crop, { tools, crop: area });
    }
    return { raw, annotated, crop };
  }

  /** Paths of a note's frozen stills that exist. */
  async existingStills(noteId: string): Promise<Partial<Stills>> {
    const out: Partial<Stills> = {};
    for (const kind of ["raw", "annotated", "crop"] as const) {
      const file = path.join(this.stillsDir, `${noteId}-${kind}.png`);
      if (await access(file).then(() => true, () => false)) out[kind] = file;
    }
    return out;
  }

  stillPath(noteId: string, kind: "raw" | "annotated" | "crop"): string {
    return path.join(this.stillsDir, `${noteId}-${kind}.png`);
  }

  /** A frame of the file as it is now, for checking a fix. */
  async currentFrame(absPath: string, frame: number): Promise<{ path: string; sha256: string; frame: number }> {
    const index = await this.index(absPath);
    const n = Math.max(0, Math.min(index.pts.length - 1, frame));
    const dir = path.join(this.stillsDir, "current");
    await mkdir(dir, { recursive: true });
    const out = path.join(dir, `${index.sha256.slice(0, 16)}-${n}.png`);
    if (!(await access(out).then(() => true, () => false))) {
      await extractStill(index, absPath, n, out, { tools: await this.tools() });
    }
    return { path: out, sha256: index.sha256, frame: n };
  }
}

/** First ffmpeg/ffprobe that exists: the setting, Homebrew, /usr/local, then PATH. */
export async function findTools(settings: { ffmpegPath: string; ffprobePath: string }): Promise<Tools> {
  const pick = async (configured: string, name: string) => {
    const candidates = [configured.trim(), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].filter(Boolean);
    for (const candidate of candidates) {
      if (await access(candidate).then(() => true, () => false)) return candidate;
    }
    return name;
  };
  return { ffmpeg: await pick(settings.ffmpegPath, "ffmpeg"), ffprobe: await pick(settings.ffprobePath, "ffprobe") };
}
