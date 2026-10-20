// Working across versions of one video: which file holds a version, how its
// frames line up with another version's, where a note lands on a newer
// render, and what changed between two renders.
import path from "node:path";
import { align, alignmentReport, mapNewFrame, mapOldFrame, type Alignment, type AlignmentReport } from "./align.ts";
import { compareFrames, type FrameCompare } from "./compare.ts";
import type { FrameIndex, Tools } from "./frames.ts";
import type { ReviewStore, VideoRow } from "./store.ts";
import { boundaryDeltas, mapByTimeline, parseTimeline, spanChanges, type BoundaryDelta, type ManifestMapping, type Timeline } from "./timeline.ts";
import type { Note, VideoVersion } from "./types.ts";
import { dropSnapshot, keepSnapshot, signatures, snapshotsToPrune, SIGNATURE_HEIGHT, SIGNATURE_WIDTH } from "./versions.ts";

export interface MediaAccess {
  index(absPath: string): Promise<FrameIndex>;
  currentSha(absPath: string): Promise<string | null>;
}

export interface FrameMap {
  frame: number;
  confidence: "high" | "medium" | "low" | "none";
  shifted: number;
}

export interface NoteMapping {
  noteId: string;
  fromSha: string;
  toSha: string;
  /** The mapped position used: the manifest's when it fits exactly, else the content alignment's. */
  frameIn: number | null;
  frameOut: number | null;
  method: "manifest" | "content" | "same-file" | "none";
  confidence: "high" | "medium" | "low" | "none";
  /** Mapped frame minus the original frame. */
  shifted: number;
  unmappable: boolean;
  manifest: (ManifestMapping & { frameOut: number | null }) | null;
  content: (FrameMap & { frameOut: number | null }) | null;
}

export interface VersionsReport {
  from: VideoVersion;
  to: VideoVersion;
  content: AlignmentReport & { ms: number };
  boundaries: BoundaryDelta[] | null;
  spans: { added: string[]; removed: string[] } | null;
}

export interface CrossVersionDeps {
  store: ReviewStore;
  media: MediaAccess;
  tools: () => Promise<Tools>;
  dataDir: string;
  maxCopyBytes: () => Promise<number>;
  log?: (message: string) => void;
}

export class CrossVersion {
  private readonly alignments = new Map<string, Promise<Alignment>>();
  private readonly deps: CrossVersionDeps;

  constructor(deps: CrossVersionDeps) {
    this.deps = deps;
  }

  /** The file that holds a version now: the video path if it still has that sha, else the kept snapshot. */
  async fileFor(video: VideoRow, sha256: string): Promise<string | null> {
    if ((await this.deps.media.currentSha(video.absPath)) === sha256) return video.absPath;
    return this.deps.store.snapshotOf(video.id, sha256);
  }

  async requireFile(video: VideoRow, version: VideoVersion): Promise<string> {
    const file = await this.fileFor(video, version.sha256);
    if (!file) {
      throw new Error(
        `${version.label} is no longer on disk${version.kept === "pruned" ? " (its copy was removed once no note needed it)" : version.kept === "none" ? " (it could not be kept)" : ""}.`,
      );
    }
    return file;
  }

  async indexFor(video: VideoRow, version: VideoVersion): Promise<{ index: FrameIndex; file: string }> {
    const file = await this.requireFile(video, version);
    const index = await this.deps.media.index(file);
    if (index.sha256 !== version.sha256) throw new Error(`The file for ${version.label} changed on disk.`);
    return { index, file };
  }

  /** Keep a snapshot of a newly seen version (no-op when it is already kept). */
  async keep(video: VideoRow, version: VideoVersion): Promise<VideoVersion> {
    if (version.kept === "clone" || version.kept === "copy") return version;
    if (version.kept === "pruned") return version;
    try {
      const result = await keepSnapshot(video.absPath, version.sha256, this.deps.dataDir, await this.deps.maxCopyBytes());
      this.deps.store.setKept(video.id, version.sha256, result.kept, result.path);
      if (result.reason) this.deps.log?.(`${version.label} of ${path.basename(video.absPath)} not kept: ${result.reason}`);
    } catch (error) {
      this.deps.log?.(`keeping ${version.label}: ${String(error)}`);
    }
    return this.deps.store.getVersion(video.id, version.sha256) ?? version;
  }

  /** Remove snapshots no open note needs; returns the labels removed. */
  async prune(video: VideoRow): Promise<string[]> {
    const versions = this.deps.store.listVersions(video.id);
    const current = await this.deps.media.currentSha(video.absPath);
    const drop = snapshotsToPrune(
      versions.map((v, order) => ({ sha256: v.sha256, order, kept: v.kept })),
      this.deps.store.listNotes(video.id),
      current,
    );
    const removed: string[] = [];
    for (const sha of drop) {
      await dropSnapshot(this.deps.dataDir, sha);
      this.deps.store.setKept(video.id, sha, "pruned", null);
      removed.push(versions.find((v) => v.sha256 === sha)?.label ?? sha.slice(0, 12));
    }
    return removed;
  }

  timeline(video: VideoRow, version: VideoVersion): Timeline | null {
    const json = this.deps.store.timelineOf(video.id, version.sha256);
    if (!json) return null;
    try {
      return parseTimeline(JSON.parse(json), version.frames);
    } catch {
      return null;
    }
  }

  /** Content alignment from one version to another, cached per pair. */
  alignment(video: VideoRow, from: VideoVersion, to: VideoVersion): Promise<Alignment> {
    const key = `${from.sha256}:${to.sha256}`;
    let pending = this.alignments.get(key);
    if (!pending) {
      pending = (async () => {
        const tools = await this.deps.tools();
        const [a, b] = await Promise.all([this.indexFor(video, from), this.indexFor(video, to)]);
        const [sa, sb] = await Promise.all([
          signatures(a.file, from.sha256, a.index.pts.length, this.deps.dataDir, tools),
          signatures(b.file, to.sha256, b.index.pts.length, this.deps.dataDir, tools),
        ]);
        return align(sa, sb, { width: SIGNATURE_WIDTH, height: SIGNATURE_HEIGHT });
      })();
      this.alignments.set(key, pending);
      pending.catch(() => this.alignments.delete(key));
      while (this.alignments.size > 16) {
        const oldest = this.alignments.keys().next().value;
        if (oldest === undefined) break;
        this.alignments.delete(oldest);
      }
    }
    return pending;
  }

  /** Where a note written on one version lands on another. */
  async mapNote(video: VideoRow, note: Note, to: VideoVersion): Promise<NoteMapping> {
    const base = {
      noteId: note.id,
      fromSha: note.mediaSha256,
      toSha: to.sha256,
      manifest: null,
      content: null,
    };
    if (note.kind === "general" || note.frameIn === null) {
      return { ...base, frameIn: null, frameOut: null, method: "same-file", confidence: "high", shifted: 0, unmappable: false };
    }
    if (note.mediaSha256 === to.sha256) {
      return { ...base, frameIn: note.frameIn, frameOut: note.frameOut, method: "same-file", confidence: "high", shifted: 0, unmappable: false };
    }
    const from = this.deps.store.getVersion(video.id, note.mediaSha256);
    if (!from) {
      return { ...base, frameIn: null, frameOut: null, method: "none", confidence: "none", shifted: 0, unmappable: true };
    }
    const frameOut = note.frameOut ?? note.frameIn;

    let manifest: NoteMapping["manifest"] = null;
    const tFrom = this.timeline(video, from);
    const tTo = this.timeline(video, to);
    if (tFrom && tTo) {
      const start = mapByTimeline(tFrom, tTo, note.frameIn);
      const end = frameOut !== note.frameIn ? mapByTimeline(tFrom, tTo, frameOut) : start;
      if (start) manifest = { ...start, frameOut: end?.frame ?? null };
    }

    let content: NoteMapping["content"] = null;
    try {
      const al = await this.alignment(video, from, to);
      const start = mapOldFrame(al, note.frameIn);
      const end = frameOut !== note.frameIn ? mapOldFrame(al, frameOut) : start;
      content = { frame: start.frame, confidence: start.confidence, shifted: start.shifted, frameOut: end.frame };
    } catch (error) {
      this.deps.log?.(`aligning ${from.label} to ${to.label}: ${String(error)}`);
    }

    const useManifest = manifest && (manifest.fit === "exact" || !content || content.confidence === "none");
    if (useManifest && manifest) {
      return {
        ...base,
        manifest,
        content,
        frameIn: manifest.frame,
        frameOut: manifest.frameOut,
        method: "manifest",
        confidence: manifest.fit === "exact" ? "high" : "medium",
        shifted: manifest.frame - note.frameIn,
        unmappable: false,
      };
    }
    if (content) {
      return {
        ...base,
        manifest,
        content,
        frameIn: content.frame,
        frameOut: content.frameOut,
        method: "content",
        confidence: content.confidence,
        shifted: content.shifted,
        unmappable: content.confidence === "none",
      };
    }
    return { ...base, manifest, content, frameIn: null, frameOut: null, method: "none", confidence: "none", shifted: 0, unmappable: true };
  }

  /** The matching frame on the other version, for side-by-side and A/B. */
  async matchFrame(video: VideoRow, from: VideoVersion, to: VideoVersion, frame: number): Promise<FrameMap> {
    if (from.sha256 === to.sha256) return { frame, confidence: "high", shifted: 0 };
    const tFrom = this.timeline(video, from);
    const tTo = this.timeline(video, to);
    const al = await this.alignment(video, from, to).catch(() => null);
    if (al) {
      const m = mapOldFrame(al, frame);
      if (m.confidence !== "none" || !(tFrom && tTo)) return { frame: m.frame, confidence: m.confidence, shifted: m.shifted };
    }
    if (tFrom && tTo) {
      const m = mapByTimeline(tFrom, tTo, frame);
      if (m) return { frame: m.frame, confidence: m.fit === "exact" ? "high" : "medium", shifted: m.frame - frame };
    }
    return { frame: Math.min(frame, to.frames - 1), confidence: "none", shifted: 0 };
  }

  /** Full frame maps both ways, for the compare view to follow playback without a round trip per frame. */
  async frameMaps(video: VideoRow, from: VideoVersion, to: VideoVersion): Promise<{ forward: number[]; backward: number[] }> {
    const al = await this.alignment(video, from, to);
    return { forward: Array.from(al.oldToNew), backward: Array.from(al.newToOld) };
  }

  async report(video: VideoRow, from: VideoVersion, to: VideoVersion): Promise<VersionsReport> {
    const al = await this.alignment(video, from, to);
    const tFrom = this.timeline(video, from);
    const tTo = this.timeline(video, to);
    return {
      from,
      to,
      content: { ...alignmentReport(al), ms: al.ms },
      boundaries: tFrom && tTo ? boundaryDeltas(tFrom, tTo) : null,
      spans: tFrom && tTo ? spanChanges(tFrom, tTo) : null,
    };
  }

  async compare(video: VideoRow, a: { version: VideoVersion; frame: number }, b: { version: VideoVersion; frame: number }): Promise<FrameCompare> {
    const [ia, ib] = await Promise.all([this.indexFor(video, a.version), this.indexFor(video, b.version)]);
    return compareFrames(
      { index: ia.index, file: ia.file, frame: a.frame },
      { index: ib.index, file: ib.file, frame: b.frame },
      path.join(this.deps.dataDir, "compare"),
      await this.deps.tools(),
    );
  }
}

export { mapNewFrame };
