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
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { exposesProtectedLocation, isProtectedLocation, type ProtectedOptions } from "./lib/authorize.ts";
import { videoReviewCli, type FrameFiles } from "./lib/cli.ts";
import { rpcContract, type FrameIndexDto } from "./lib/contract.ts";
import { VideoFiles } from "./lib/files.ts";
import { frameLabel, type FrameIndex } from "./lib/frames.ts";
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
  });
  const media = new VideoMedia(async () => findTools(await settings.get()), path.join(dataDir, "stills"));

  const protectedOptions: ProtectedOptions = {
    home: os.homedir(),
    dataDir: dataDirFromDatabaseName(database.name),
    dropsDir: null,
  };

  function publish(videoIds: string[]): void {
    if (videoIds.length > 0) bb.realtime.publish(CHANGED, { videoIds });
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
    const version = store.registerVersion(video.id, {
      sha256: index.sha256,
      width: index.width,
      height: index.height,
      fpsNum: index.fps.num,
      fpsDen: index.fps.den,
      frames: index.pts.length,
    });
    return { index, version };
  }

  /** A short-lived URL the browser streams the video from (bb's preview server handles ranges). */
  async function mediaUrl(video: VideoRow, refresh = false): Promise<{ url: string; expiresAtMs: number }> {
    const directory = path.dirname(video.absPath);
    if (isProtectedLocation(video.absPath, protectedOptions) || exposesProtectedLocation(directory, protectedOptions)) {
      throw new Error("Videos in your home folder itself or in protected folders are not served; move it into a project folder.");
    }
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
    return { url: joinPreviewUrl(entry.baseUrl, path.basename(video.absPath)), expiresAtMs: entry.expiresAtMs };
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

  bb.rpc.register(rpcContract, {
    async "video.open"({ path: rawPath, source }) {
      const extension = rawPath.split(".").pop()?.toLowerCase() ?? "";
      if (!VIDEO_EXTENSIONS.includes(extension)) throw new Error(`Video Review opens ${VIDEO_EXTENSIONS.map((e) => `.${e}`).join(", ")} files.`);
      const absPath = await files.resolve(rawPath, source);
      const video = store.upsertVideo(null, absPath);
      const { index, version } = await currentVersion(video);
      return { video: toReviewVideo(video), version, index: indexDto(index), media: await mediaUrl(video) };
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

  bb.cli.register(
    videoReviewCli({
      store,
      onChanged: publish,
      currentSha: (video) => media.currentSha(video.absPath),
      frameFiles,
    }),
  );
}
