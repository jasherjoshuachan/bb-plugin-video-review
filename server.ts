// bb-plugin-video-review — backend entry.
//
// Review a rendered video frame by frame in a panel tab, then hand the notes
// to an agent in one message. Every note is pinned to a frame (or range) of
// one exact file, named by its sha256. Notes live in this plugin's SQLite
// database; the video is never modified. Agents report back with
// `bb video-review`, and every change reaches open tabs through a realtime
// signal.
//
// The hand-off (send to this chat or a new one, images attached or saved
// beside the plugin data) is adapted from Doc Review (MIT, (c) 2026 Foma);
// the preview-URL cache and protected-location checks come from Inline
// Media. See NOTICE.
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { exposesProtectedLocation, isInThreadStorage, isProtectedLocation, type ProtectedOptions } from "./lib/authorize.ts";
import { videoReviewCli, type CompareResult, type FrameFiles } from "./lib/cli.ts";
import { CrossVersion } from "./lib/crossversion.ts";
import { parseTimeline } from "./lib/timeline.ts";
import { buildScrub, type ScrubMeta } from "./lib/scrub.ts";
import { rpcContract, type FrameIndexDto } from "./lib/contract.ts";
import { joinPath, VideoFiles, type OpenerSource } from "./lib/files.ts";
import { frameAtTime, frameDuration, frameLabel, type FrameIndex } from "./lib/frames.ts";
import { dataDirFromDatabaseName, joinPreviewUrl } from "./lib/inside.ts";
import { findTools, VideoMedia } from "./lib/media.ts";
import { buildHandoffMessage } from "./lib/message.ts";
import { createPreviewCache, previewCacheKey } from "./lib/preview-cache.ts";
import { MIGRATIONS, ReviewStore, toReviewVideo, type Db, type NoteWithVideo, type VideoRow } from "./lib/store.ts";
import type { Note, VideoVersion } from "./lib/types.ts";

export { rpcContract };
export type { RpcContract } from "./lib/contract.ts";

/** Realtime channel the tab listens on; payload `{ videoIds }`. */
const CHANGED = "video-review-changed";
const STILL_ROUTE = "/still";
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const NO_PROJECT = "This file is not in a project, so a new chat cannot be started from here.";
const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm"];
/** An open request written by `bb video-review open`: which video, which frame, which version to compare. */
const INTENT_EXTENSION = "vreview";
const INTENT = "video-review-intent";
const COMPARE_ROUTE = "/compare";

export default async function plugin(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, MIGRATIONS);
  const store = new ReviewStore(database as unknown as Db);
  const dataDir = path.dirname(database.name);
  const files = new VideoFiles(bb);
  const previews = createPreviewCache();

  const settings = bb.settings.define({
    ffmpegPath: {
      type: "string",
      label: "ffmpeg executable",
      description: "Leave empty to use Homebrew's, /usr/local/bin, or the one on PATH.",
      default: "",
    },
    ffprobePath: {
      type: "string",
      label: "ffprobe executable",
      description: "Leave empty to use Homebrew's, /usr/local/bin, or the one on PATH.",
      default: "",
    },
    snapshotCopyMaxMb: {
      type: "number",
      label: "Largest render to copy when it cannot be cloned (MB)",
      description:
        "Older renders are kept as copy-on-write clones, which take no space until the original is rewritten. Where cloning is not possible, renders up to this size are copied; bigger ones are not kept.",
      default: 300,
    },
  });
  const media = new VideoMedia(async () => findTools(await settings.get()), path.join(dataDir, "stills"));

  const protectedOptions: ProtectedOptions = {
    home: os.homedir(),
    dataDir: dataDirFromDatabaseName(database.name),
    dropsDir: null,
  };

  const tools = async () => findTools(await settings.get());
  const cross = new CrossVersion({
    store,
    media,
    tools,
    dataDir,
    maxCopyBytes: async () => Math.max(0, Number((await settings.get()).snapshotCopyMaxMb ?? 300)) * 1e6,
    log: (message) => bb.log.info(message),
  });

  function publish(videoIds: string[]): void {
    if (videoIds.length > 0) bb.realtime.publish(CHANGED, { videoIds });
    for (const id of videoIds) {
      const video = store.getVideo(id);
      if (video) void cross.prune(video).catch((error: unknown) => bb.log.warn(`prune: ${String(error)}`));
    }
  }

  /** Picks up `<video>.timeline.json` beside the video for a version that has no manifest yet. */
  async function sidecarTimeline(video: VideoRow, version: VideoVersion): Promise<boolean> {
    if (version.hasTimeline) return false;
    const candidates = [`${video.absPath}.timeline.json`, video.absPath.replace(/\.[^./]+$/, ".timeline.json")];
    for (const file of candidates) {
      const text = await readFile(file, "utf8").catch(() => null);
      if (text === null) continue;
      try {
        parseTimeline(JSON.parse(text), version.frames);
        store.setTimeline(video.id, version.sha256, text);
        return true;
      } catch (error) {
        bb.log.warn(`${file}: ${String(error)}`);
      }
    }
    return false;
  }

  /** New versions are kept (cloned) in the background; tabs hear about it when done. */
  function keepInBackground(video: VideoRow, version: VideoVersion): void {
    if (version.kept !== "none") return;
    void cross
      .keep(video, version)
      .then(() => publish([video.id]))
      .catch((error: unknown) => bb.log.warn(`keep ${version.label}: ${String(error)}`));
  }

  /** Scrubber files per version, built once; concurrent tabs share one build. */
  const scrubBuilds = new Map<string, Promise<ScrubMeta>>();
  function scrubFor(file: string, index: FrameIndex): Promise<ScrubMeta> {
    let pending = scrubBuilds.get(index.sha256);
    if (!pending) {
      const duration = (index.pts[index.pts.length - 1] ?? 0) - index.formatStart + frameDuration(index);
      pending = settings
        .get()
        .then((values) => findTools(values))
        .then((tools) =>
          buildScrub(tools, file, path.join(dataDir, "scrub", index.sha256.slice(0, 32)), {
            sha256: index.sha256,
            duration,
            width: index.width,
            height: index.height,
          }),
        );
      scrubBuilds.set(index.sha256, pending);
      pending.catch(() => scrubBuilds.delete(index.sha256));
    }
    return pending;
  }

  function requireVideo(videoId: string): VideoRow {
    const video = store.getVideo(videoId);
    if (!video) throw new Error("This video is no longer known; reopen the file.");
    return video;
  }

  function indexDto(index: FrameIndex): FrameIndexDto {
    return {
      sha256: index.sha256,
      width: index.width,
      height: index.height,
      fps: index.fps,
      vfr: index.vfr,
      formatStart: index.formatStart,
      pts: index.pts,
    };
  }

  /** Probes the file on disk now and records it as a version of the video. */
  async function currentVersion(video: VideoRow): Promise<{ index: FrameIndex; version: VideoVersion }> {
    const index = await media.index(video.absPath);
    let version = store.registerVersion(video.id, {
      sha256: index.sha256,
      width: index.width,
      height: index.height,
      fpsNum: index.fps.num,
      fpsDen: index.fps.den,
      frames: index.pts.length,
    });
    if (await sidecarTimeline(video, version)) version = store.getVersion(video.id, version.sha256) ?? version;
    keepInBackground(video, version);
    return { index, version };
  }

  /** A short-lived URL for a file; bb's preview server handles range requests. */
  async function previewUrl(file: string, refresh: boolean): Promise<{ url: string; expiresAtMs: number }> {
    const directory = path.dirname(file);
    const hostId = (await files.localHostId()) ?? undefined;
    const entry = await previews.obtain(
      previewCacheKey(hostId, directory),
      async () => {
        const preview = await bb.sdk.files.createPreview({
          ...(hostId ? { hostId } : {}),
          rootPath: directory,
          ttlMs: PREVIEW_TTL_MS,
        });
        return { baseUrl: preview.baseUrl, expiresAtMs: preview.expiresAtMs ?? Date.now() + PREVIEW_TTL_MS };
      },
      refresh,
    );
    return { url: joinPreviewUrl(entry.baseUrl, path.basename(file)), expiresAtMs: entry.expiresAtMs };
  }

  /** The video file as it is on disk; refused from protected folders. */
  async function mediaUrl(video: VideoRow, refresh = false): Promise<{ url: string; expiresAtMs: number }> {
    const directory = path.dirname(video.absPath);
    const realFile = await realpath(video.absPath).catch(() => video.absPath);
    const storedInThread =
      isInThreadStorage(video.absPath, protectedOptions.dataDir) &&
      isInThreadStorage(realFile, protectedOptions.dataDir) &&
      isInThreadStorage(directory, protectedOptions.dataDir, true);
    if (
      !storedInThread &&
      (isProtectedLocation(video.absPath, protectedOptions) ||
        isProtectedLocation(realFile, protectedOptions) ||
        exposesProtectedLocation(directory, protectedOptions))
    ) {
      throw new Error("Videos in your home folder itself or in protected folders are not served; move it into a project folder.");
    }
    return previewUrl(video.absPath, refresh);
  }

  /** Any version: the file on disk when it still has that sha, else the kept snapshot (the plugin's own folder of renders). */
  async function versionMediaUrl(video: VideoRow, version: VideoVersion, refresh = false): Promise<{ url: string; expiresAtMs: number }> {
    if ((await media.currentSha(video.absPath)) === version.sha256) return mediaUrl(video, refresh);
    return previewUrl(await cross.requireFile(video, version), refresh);
  }

  function requireVersion(video: VideoRow, ref: string): VideoVersion {
    const version = store.findVersion(video.id, ref) ?? store.getVersion(video.id, ref);
    if (!version) {
      const known = store.listVersions(video.id).map((v) => v.label).join(", ") || "none";
      throw new Error(`No version ${ref} of ${path.basename(video.absPath)} (known: ${known}).`);
    }
    return version;
  }

  async function currentVersionOf(video: VideoRow): Promise<VideoVersion> {
    return (await currentVersion(video)).version;
  }

  function compareUrl(file: string): string {
    return `/api/v1/plugins/${bb.pluginId}/http${COMPARE_ROUTE}?file=${encodeURIComponent(path.basename(file))}`;
  }

  /** Thread roots a video may be opened from: the workspace and the thread's storage. */
  async function threadRoots(threadId: string): Promise<Array<{ source: "workspace" | "thread-storage"; root: string; environmentId: string | null }>> {
    const roots: Array<{ source: "workspace" | "thread-storage"; root: string; environmentId: string | null }> = [];
    const thread: unknown = await bb.sdk.threads.get({ threadId, include: "environment" }).catch(() => null);
    const environment = thread && typeof thread === "object" ? (thread as { environment?: unknown }).environment : undefined;
    if (environment && typeof environment === "object") {
      const env = environment as { path?: unknown; id?: unknown };
      if (typeof env.path === "string" && env.path) roots.push({ source: "workspace", root: env.path, environmentId: typeof env.id === "string" ? env.id : null });
    }
    const storage = await bb.sdk.threads.storageLocation({ threadId });
    roots.push({ source: "thread-storage", root: storage.storageRootPath, environmentId: null });
    return roots;
  }

  interface Intent {
    video: { source: "workspace" | "thread-storage"; path: string; environmentId: string | null; threadId: string };
    frame: number | null;
    compare: string | null;
    at: number;
  }

  async function readIntent(rawPath: string, source: OpenerSource): Promise<{ absPath: string; intent: Intent }> {
    const intentFile = await files.resolve(rawPath, source);
    const parsed = JSON.parse(await readFile(intentFile, "utf8")) as Intent;
    if (!parsed?.video || typeof parsed.video.path !== "string" || !["workspace", "thread-storage"].includes(parsed.video.source)) {
      throw new Error("This .vreview file does not name a video.");
    }
    const roots = await threadRoots(parsed.video.threadId);
    const root = roots.find((r) => r.source === parsed.video.source);
    if (!root) throw new Error("The thread this review was opened from has no such folder.");
    return { absPath: joinPath(root.root, parsed.video.path), intent: parsed };
  }

  function versionsBySha(videoId: string): Map<string, VideoVersion> {
    return new Map(store.listVersions(videoId).map((version) => [version.sha256, version]));
  }

  /** The images that go with each note: the marked-up frame (else the plain one) and the crop. */
  async function noteImages(notes: Note[]): Promise<Map<string, string[]>> {
    const images = new Map<string, string[]>();
    for (const note of notes) {
      if (note.kind === "general") continue;
      const stills = await media.existingStills(note.id);
      const list = [stills.annotated ?? stills.raw, stills.crop].filter((p): p is string => Boolean(p));
      if (list.length > 0) images.set(note.id, list);
    }
    return images;
  }

  function pickNotes(videoId: string, ids: string[] | undefined): Note[] {
    const all = store.listNotes(videoId);
    const chosen = ids ? all.filter((note) => ids.includes(note.id)) : all.filter((note) => note.status === "draft");
    if (chosen.length === 0) throw new Error("There are no draft notes to send.");
    return chosen;
  }

  async function frameFiles(note: NoteWithVideo, options: { current: boolean }): Promise<FrameFiles> {
    const frame = note.frameIn ?? 0;
    if (options.current) {
      const current = await media.currentFrame(note.video.absPath, frame);
      return { frame: current.frame, sha256: current.sha256, files: [{ kind: "raw", path: current.path }] };
    }
    let stills = await media.existingStills(note.id);
    if (!stills.raw) {
      // Stills are written with the note; rebuild them only from the same file.
      const index = await media.index(note.video.absPath);
      if (index.sha256 !== note.mediaSha256) {
        throw new Error(
          `The note's stills are missing and the file has changed since ${note.versionLabel}. Use --current for the same frame number on the file on disk now.`,
        );
      }
      stills = await media.noteStills(note.id, note.video.absPath, index, frame, note.shapes, note.rect);
    }
    const out: FrameFiles["files"] = [];
    for (const kind of ["raw", "annotated", "crop"] as const) {
      const file = stills[kind];
      if (file) out.push({ kind, path: file });
    }
    return { frame, sha256: note.mediaSha256, files: out };
  }

  bb.http.route("GET", STILL_ROUTE, async (context) => {
    const noteId = context.req.query("note") ?? "";
    const kind = context.req.query("kind") ?? "raw";
    if (!/^n_[a-z0-9]{6}$/.test(noteId) || !["raw", "annotated", "crop"].includes(kind)) {
      return context.text("Not found", 404);
    }
    try {
      const bytes = await readFile(media.stillPath(noteId, kind as "raw" | "annotated" | "crop"));
      return new Response(new Uint8Array(bytes), {
        headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" },
      });
    } catch {
      return context.text("Not found", 404);
    }
  });

  bb.http.route("GET", COMPARE_ROUTE, async (context) => {
    const name = context.req.query("file") ?? "";
    if (!/^[0-9a-f]{12}-\d+-vs-[0-9a-f]{12}-\d+-(a|b|diff)\.png$/.test(name)) return context.text("Not found", 404);
    try {
      const bytes = await readFile(path.join(dataDir, "compare", name));
      return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
    } catch {
      return context.text("Not found", 404);
    }
  });

  bb.rpc.register(rpcContract, {
    async "video.open"({ path: rawPath, source }) {
      const extension = rawPath.split(".").pop()?.toLowerCase() ?? "";
      let absPath: string;
      let intent: { frame: number | null; compare: string | null } | null = null;
      if (extension === INTENT_EXTENSION) {
        const read = await readIntent(rawPath, source);
        absPath = read.absPath;
        intent = { frame: read.intent.frame, compare: read.intent.compare };
      } else {
        if (!VIDEO_EXTENSIONS.includes(extension)) throw new Error(`Video Review opens ${VIDEO_EXTENSIONS.map((e) => `.${e}`).join(", ")} files.`);
        absPath = await files.resolve(rawPath, source);
      }
      const video = store.upsertVideo(null, absPath);
      const { index, version } = await currentVersion(video);
      void scrubFor(absPath, index).catch((error: unknown) => bb.log.warn(`scrubber for ${version.label}: ${String(error)}`));   // ready by the time the tab asks
      return { video: toReviewVideo(video), version, index: indexDto(index), media: await mediaUrl(video), intent };
    },

    async "versions.list"({ videoId }) {
      const video = requireVideo(videoId);
      return { versions: store.listVersions(videoId), currentSha: await media.currentSha(video.absPath) };
    },

    async "versions.load"({ videoId, sha256 }) {
      const video = requireVideo(videoId);
      const version = requireVersion(video, sha256);
      const { index } = await cross.indexFor(video, version);
      return { version, index: indexDto(index), media: await versionMediaUrl(video, version) };
    },

    async "scrub.assets"({ videoId, sha256 }) {
      const video = requireVideo(videoId);
      const version = requireVersion(video, sha256);
      const { index, file } = await cross.indexFor(video, version);
      const meta = await scrubFor(file, index);
      const dir = path.join(dataDir, "scrub", index.sha256.slice(0, 32));
      const proxy = await previewUrl(path.join(dir, meta.proxy), false);
      const sheetUrls = await Promise.all(meta.sheets.map(async (name) => (await previewUrl(path.join(dir, name), false)).url));
      const toFrame = (t: number) => frameAtTime(index, t + index.formatStart);
      const raw = store.timelineOf(video.id, version.sha256);
      let sections: { id: string; start: number; end: number }[] = [];
      let scenes: { id: string; kind?: string; start: number; end: number }[] = [];
      if (raw) {
        try {
          const timeline = parseTimeline(JSON.parse(raw), index.pts.length);
          sections = timeline.sections;
          scenes = timeline.scenes;
        } catch (error) {
          bb.log.warn(`timeline of ${version.label}: ${String(error)}`);
        }
      }
      return {
        proxyUrl: proxy.url,
        sheetUrls,
        step: meta.step,
        count: meta.count,
        cols: meta.cols,
        rows: meta.rows,
        w: meta.w,
        h: meta.h,
        black: meta.black.map(([a, b]) => [toFrame(a), Math.max(toFrame(a), toFrame(b) - 1)] as [number, number]),
        sections,
        scenes,
        expiresAtMs: proxy.expiresAtMs,
      };
    },

    async "versions.mediaUrl"({ videoId, sha256, refresh }) {
      const video = requireVideo(videoId);
      return versionMediaUrl(video, requireVersion(video, sha256), refresh ?? false);
    },

    async "versions.maps"({ videoId, fromSha, toSha }) {
      const video = requireVideo(videoId);
      const from = requireVersion(video, fromSha);
      const to = requireVersion(video, toSha);
      if (from.sha256 === to.sha256) {
        const same = Array.from({ length: from.frames }, (_, i) => i);
        return { forward: same, backward: same };
      }
      return cross.frameMaps(video, from, to);
    },

    async "versions.report"({ videoId, fromSha, toSha }) {
      const video = requireVideo(videoId);
      return cross.report(video, requireVersion(video, fromSha), requireVersion(video, toSha));
    },

    async "notes.mapped"({ videoId, toSha }) {
      const video = requireVideo(videoId);
      const to = requireVersion(video, toSha);
      const mappings = [];
      for (const note of store.listNotes(videoId)) {
        if (note.mediaSha256 === to.sha256 || note.kind === "general" || note.frameIn === null) continue;
        mappings.push(await cross.mapNote(video, note, to));
      }
      return { mappings };
    },

    async "compare.frames"({ videoId, aSha, aFrame, bSha, bFrame }) {
      const video = requireVideo(videoId);
      const a = requireVersion(video, aSha);
      const b = requireVersion(video, bSha);
      const target = bFrame ?? (await cross.matchFrame(video, a, b, aFrame)).frame;
      const result = await cross.compare(video, { version: a, frame: aFrame }, { version: b, frame: target });
      return {
        aFrame,
        bFrame: target,
        diff: result.diff,
        urls: { a: compareUrl(result.files.a), b: compareUrl(result.files.b), difference: compareUrl(result.files.difference) },
      };
    },

    async "video.state"({ videoId }) {
      const video = requireVideo(videoId);
      const sha256 = await media.currentSha(video.absPath);
      if (sha256) await currentVersion(video);
      return { sha256, versions: store.listVersions(videoId) };
    },

    async "video.reload"({ videoId }) {
      const video = requireVideo(videoId);
      const { index, version } = await currentVersion(video);
      return { version, index: indexDto(index), media: await mediaUrl(video, true) };
    },

    async "video.mediaUrl"({ videoId, refresh }) {
      return mediaUrl(requireVideo(videoId), refresh ?? false);
    },

    async "notes.list"({ videoId }) {
      requireVideo(videoId);
      return {
        notes: store.listNotes(videoId),
        versions: store.listVersions(videoId),
        stillBase: `/api/v1/plugins/${bb.pluginId}/http${STILL_ROUTE}`,
      };
    },

    async "notes.create"({ videoId, sha256, kind, frameIn, frameOut, text, category, shapes }) {
      const video = requireVideo(videoId);
      const { index, version } = await currentVersion(video);
      if (index.sha256 !== sha256) {
        throw new Error("The video changed on disk while you were writing; reload it and place the note again.");
      }
      const last = index.pts.length - 1;
      let first: number | null = null;
      let end: number | null = null;
      if (kind !== "general") {
        if (frameIn === null || frameIn > last) throw new Error(`The frame must be between 0 and ${last}.`);
        first = frameIn;
        end = kind === "range" ? frameOut ?? frameIn : frameIn;
        if (end < first || end > last) throw new Error(`The range must end between ${first} and ${last}.`);
      }
      const note = store.createNote({
        videoId,
        mediaSha256: index.sha256,
        versionLabel: version.label,
        fpsNum: index.fps.num,
        fpsDen: index.fps.den,
        kind,
        frameIn: first,
        frameOut: end,
        frameLabel: first === null ? null : frameLabel(index, first, version.label),
        text,
        category,
        rect: null,
        shapes,
      });
      if (first !== null) {
        try {
          await media.noteStills(note.id, video.absPath, index, first, shapes, null);
        } catch (error) {
          bb.log.warn(`stills for ${note.id}: ${String(error)}`);
        }
      }
      publish([videoId]);
      return note;
    },

    async "notes.update"({ id, text, category, shapes }) {
      const existing = store.getNote(id);
      if (!existing) throw new Error("This note was deleted.");
      const note = store.updateNote(id, { text, category, shapes });
      if (shapes && note.frameIn !== null) {
        // Redraw the markup only on the file the note was written on.
        const index = await media.index(existing.video.absPath).catch(() => null);
        if (index && index.sha256 === note.mediaSha256) {
          await media.noteStills(note.id, existing.video.absPath, index, note.frameIn, note.shapes, note.rect).catch(
            (error: unknown) => bb.log.warn(`stills for ${note.id}: ${String(error)}`),
          );
        }
      }
      publish([existing.video.id]);
      return note;
    },

    async "notes.delete"({ id }) {
      const existing = store.getNote(id);
      const deleted = store.deleteNote(id);
      if (existing) publish([existing.video.id]);
      return { deleted };
    },

    async "notes.reopen"({ id }) {
      const existing = store.getNote(id);
      if (!existing) throw new Error("This note was deleted.");
      const note = store.reopen(id);
      publish([existing.video.id]);
      return note;
    },

    async "notes.verify"({ id }) {
      const existing = store.getNote(id);
      if (!existing) throw new Error("This note was deleted.");
      const note = store.verify(id);
      publish([existing.video.id]);
      return note;
    },

    async "notes.wontfix"({ id, note: text }) {
      const existing = store.getNote(id);
      if (!existing) throw new Error("This note was deleted.");
      const note = store.wontfix(id, text?.trim() || null);
      publish([existing.video.id]);
      return note;
    },

    async "notes.send"({ videoId, ids, target }) {
      const video = requireVideo(videoId);
      const notes = pickNotes(videoId, ids);
      const { version } = await currentVersion(video);

      let projectId: string | null = null;
      let sourceThreadId: string | null = null;
      if (target.kind === "thread") {
        projectId = (await bb.sdk.threads.get({ threadId: target.threadId })).projectId;
      } else {
        sourceThreadId = target.sourceThreadId;
        projectId = target.projectId;
        if (!projectId && sourceThreadId) projectId = (await bb.sdk.threads.get({ threadId: sourceThreadId })).projectId;
        if (!projectId) throw new Error(NO_PROJECT);
      }

      // Attach the stills when bb accepts the upload; otherwise name their paths.
      const images = await noteImages(notes);
      const imageNumbers = new Map<string, number[]>();
      const imagePaths = new Map<string, string[]>();
      const imageInputs: { type: "localImage"; path: string }[] = [];
      for (const note of notes) {
        for (const file of images.get(note.id) ?? []) {
          try {
            const uploaded = await bb.sdk.projects.attachments.upload({
              projectId,
              clientFile: new Uint8Array(await readFile(file)),
              filename: path.basename(file),
              mimeType: "image/png",
            });
            imageInputs.push({ type: "localImage", path: uploaded.path });
            imageNumbers.set(note.id, [...(imageNumbers.get(note.id) ?? []), imageInputs.length]);
          } catch (error) {
            bb.log.warn(`attachment upload for ${note.id}: ${String(error)}`);
            imagePaths.set(note.id, [...(imagePaths.get(note.id) ?? []), file]);
          }
        }
      }

      const text = buildHandoffMessage({
        absPath: video.absPath,
        current: version,
        notes,
        versions: versionsBySha(videoId),
        imageNumbers,
        imagePaths,
      });
      const input = [{ type: "text" as const, text, mentions: [] }, ...imageInputs];

      let threadId: string;
      if (target.kind === "thread") {
        await bb.sdk.threads.send({ threadId: target.threadId, mode: "auto", input });
        threadId = target.threadId;
      } else {
        // Reuse the model and workspace of the thread the tab was opened in.
        type SpawnArgs = Parameters<typeof bb.sdk.threads.spawn>[0];
        const execution: Partial<Pick<SpawnArgs, "providerId" | "model" | "reasoningLevel" | "permissionMode">> = {};
        let environmentId = target.environmentId;
        if (sourceThreadId) {
          const source = await bb.sdk.threads.get({ threadId: sourceThreadId });
          environmentId ??= source.environmentId;
          execution.providerId = source.providerId;
          const options = await bb.sdk.threads.defaultExecutionOptions({ threadId: sourceThreadId }).catch(() => null);
          if (options) {
            execution.model = options.model;
            execution.reasoningLevel = options.reasoningLevel;
            execution.permissionMode = options.permissionMode;
          }
        }
        const created = await bb.sdk.threads.spawn({
          projectId,
          environment: environmentId ? { type: "reuse", environmentId } : { type: "project-default" },
          input,
          title: `Video review: ${path.basename(video.absPath)}`,
          ...execution,
        });
        threadId = created.id;
      }

      const sent = store.markSent(notes.map((note) => note.id), threadId);
      publish([videoId]);
      return { threadId, sent };
    },

    async "notes.handoffPrompt"({ videoId, ids }) {
      const video = requireVideo(videoId);
      const notes = pickNotes(videoId, ids);
      const { version } = await currentVersion(video);
      const prompt = buildHandoffMessage({
        absPath: video.absPath,
        current: version,
        notes,
        versions: versionsBySha(videoId),
        imageNumbers: new Map(),
        imagePaths: await noteImages(notes),
      });
      return { prompt, ids: notes.map((note) => note.id) };
    },

    async "notes.markSent"({ ids, threadId }) {
      const videoIds = new Set<string>();
      for (const id of ids) {
        const note = store.getNote(id);
        if (note) videoIds.add(note.video.id);
      }
      const sent = store.markSent(ids, threadId);
      publish([...videoIds]);
      return { sent };
    },
  });

  function videoFor(file: string): VideoRow {
    const known = store.findVideosByPath(file);
    if (known.length > 0) return known[0];
    return store.upsertVideo(null, file);
  }

  function diffLines(label: string, diff: { mean: number; max: number; changedShare: number; box: { x: number; y: number; w: number; h: number } | null }): string {
    const where = diff.box ? `changed area x=${diff.box.x} y=${diff.box.y} w=${diff.box.w} h=${diff.box.h} px` : "no pixel changed by more than the threshold";
    return `${label}: mean difference ${diff.mean}, max ${diff.max}, ${(diff.changedShare * 100).toFixed(2)}% of pixels changed; ${where}`;
  }

  async function compareNote(note: NoteWithVideo, toRef: string | null): Promise<CompareResult> {
    const video = note.video;
    const to = toRef ? requireVersion(video, toRef) : await currentVersionOf(video);
    const from = store.getVersion(video.id, note.mediaSha256);
    if (!from) throw new Error(`The version ${note.versionLabel} is not known.`);
    const mapping = await cross.mapNote(video, note, to);
    if (mapping.frameIn === null) {
      return {
        text: `${note.id}: frame ${note.frameIn} of ${from.label} has no reliable match on ${to.label}.`,
        data: { mapping },
      };
    }
    const result = await cross.compare(video, { version: from, frame: note.frameIn! }, { version: to, frame: mapping.frameIn });
    const lines = [
      `${note.id}: ${from.label} frame ${note.frameIn} -> ${to.label} frame ${mapping.frameIn} (${mapping.method}, ${mapping.confidence} confidence, moved ${mapping.shifted >= 0 ? "+" : ""}${mapping.shifted} frames)`,
      ...(mapping.manifest && mapping.content && mapping.manifest.frame !== mapping.content.frame
        ? [`  manifest says frame ${mapping.manifest.frame} (${mapping.manifest.by} ${mapping.manifest.id}, ${mapping.manifest.fit}); picture match says ${mapping.content.frame}`]
        : []),
      diffLines("  pixels", result.diff),
      `  ${from.label}: ${result.files.a}`,
      `  ${to.label}: ${result.files.b}`,
      `  difference: ${result.files.difference}`,
    ];
    return { text: lines.join("\n"), data: { mapping, diff: result.diff, files: result.files } };
  }

  async function compareVersions(file: string, aRef: string, bRef: string, frame: number | null): Promise<CompareResult> {
    const video = videoFor(file);
    await currentVersion(video).catch(() => null);
    const a = requireVersion(video, aRef);
    const b = requireVersion(video, bRef);
    if (frame !== null) {
      if (frame >= a.frames) throw new Error(`${a.label} has frames 0–${a.frames - 1}.`);
      const match = await cross.matchFrame(video, a, b, frame);
      const result = await cross.compare(video, { version: a, frame }, { version: b, frame: match.frame });
      const lines = [
        `${a.label} frame ${frame} -> ${b.label} frame ${match.frame} (${match.confidence} confidence, moved ${match.shifted >= 0 ? "+" : ""}${match.shifted})`,
        diffLines("pixels", result.diff),
        `${a.label}: ${result.files.a}`,
        `${b.label}: ${result.files.b}`,
        `difference: ${result.files.difference}`,
      ];
      return { text: lines.join("\n"), data: { match, diff: result.diff, files: result.files } };
    }
    const report = await cross.report(video, a, b);
    const fps = a.fpsNum / a.fpsDen;
    const at = (f: number) => `${f} (${(f / fps).toFixed(2)} s)`;
    const lines = [`${a.label} -> ${b.label}: ${(report.content.matched * 100).toFixed(1)}% of frames matched (aligned in ${report.content.ms} ms)`];
    lines.push(report.content.shifts.length === 0 ? "Timing: no shifts." : "Timing shifts (by picture):");
    for (const s of report.content.shifts) {
      lines.push(`  from ${a.label} frame ${at(s.oldFrame)}: ${s.delta > 0 ? "+" : ""}${s.delta} frames (now ${s.offsetAfter >= 0 ? "+" : ""}${s.offsetAfter} vs ${a.label})`);
    }
    const changed = report.content.changes;
    lines.push(changed.length === 0 ? "Pictures: no changes above the noise." : "Pictures that differ (frames of " + b.label + "):");
    for (const c of changed) {
      lines.push(`  ${c.kind}: ${c.from === c.to ? at(c.from) : `${at(c.from)} – ${at(c.to)}`}, max difference ${c.maxDistance}`);
    }
    for (const r of report.content.removals) lines.push(`  removed from ${a.label}: frames ${at(r.from)} – ${at(r.to)}`);
    if (report.boundaries) {
      lines.push(report.boundaries.length === 0 ? "Manifest: no scene or section edge moved." : "Manifest edges that moved:");
      for (const d of report.boundaries) lines.push(`  ${d.by} ${d.id} ${d.edge}: ${at(d.oldFrame)} -> ${at(d.newFrame)} (${d.delta > 0 ? "+" : ""}${d.delta})`);
      if (report.spans && (report.spans.added.length || report.spans.removed.length)) {
        lines.push(`  added: ${report.spans.added.join(", ") || "none"}; removed: ${report.spans.removed.join(", ") || "none"}`);
      }
    } else {
      lines.push(`Manifest: not stored for both versions (bb ${"video-review"} timeline <video> <json>).`);
    }
    return { text: lines.join("\n"), data: report };
  }

  async function registerTimeline(file: string, jsonText: string) {
    const video = videoFor(file);
    const { version } = await currentVersion(video);
    let parsed;
    try {
      parsed = parseTimeline(JSON.parse(jsonText), version.frames);
    } catch (error) {
      throw new Error(error instanceof SyntaxError ? `The manifest is not valid JSON: ${error.message}` : (error as Error).message);
    }
    store.setTimeline(video.id, version.sha256, jsonText);
    return { label: version.label, sha256: version.sha256, sections: parsed.sections.length, scenes: parsed.scenes.length };
  }

  async function openInThread(file: string, options: { threadId: string; frame: number | null; compare: string | null }): Promise<string> {
    const extension = file.split(".").pop()?.toLowerCase() ?? "";
    if (!VIDEO_EXTENSIONS.includes(extension)) throw new Error(`Video Review opens ${VIDEO_EXTENSIONS.map((e) => `.${e}`).join(", ")} files.`);
    const roots = await threadRoots(options.threadId);
    const real = await realpath(file).catch(() => null);
    if (!real) throw new Error(`No such file: ${file}`);
    const root = roots.find((r) => file === r.root || file.startsWith(r.root.endsWith("/") ? r.root : `${r.root}/`));
    if (!root) {
      throw new Error("The video must be in this thread's workspace or its thread storage (bb opens files only from there).");
    }
    const video = videoFor(file);
    const { version } = await currentVersion(video);
    if (options.frame !== null && options.frame >= version.frames) throw new Error(`${version.label} has frames 0–${version.frames - 1}.`);
    if (options.compare) requireVersion(video, options.compare);
    const storage = roots.find((r) => r.source === "thread-storage")!;
    const intent: Intent = {
      video: { source: root.source, path: path.posix.relative(root.root, file), environmentId: root.environmentId, threadId: options.threadId },
      frame: options.frame,
      compare: options.compare,
      at: Date.now(),
    };
    const relative = path.posix.join("video-review", `${path.basename(file)}.${INTENT_EXTENSION}`);
    await mkdir(path.join(storage.root, "video-review"), { recursive: true });
    await writeFile(path.join(storage.root, relative), JSON.stringify(intent, null, 2));
    // A tab already showing this video jumps; a new tab reads the intent file.
    bb.realtime.publish(INTENT, { videoId: video.id, frame: options.frame, compare: options.compare });
    await bb.sdk.threads.open({ threadId: options.threadId, split: "right", file: { source: "thread-storage", path: relative, lineNumber: null } });
    return `Opened ${path.basename(file)} (${version.label}) in Video Review${options.frame !== null ? ` at frame ${options.frame}` : ""}${options.compare ? `, comparing with ${options.compare}` : ""}.`;
  }

  bb.cli.register(
    videoReviewCli({
      store,
      onChanged: publish,
      currentSha: (video) => media.currentSha(video.absPath),
      frameFiles,
      registerTimeline,
      compareNote,
      compareVersions,
      open: openInThread,
    }),
  );
}
