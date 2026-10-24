// RPC contract between the review tab (app.tsx) and the backend. app.tsx
// imports only its type, so zod never reaches the frontend bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { NOTE_CATEGORIES, NOTE_KINDS, NOTE_STATUSES } from "./types.ts";

const shapeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("box"), x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal("arrow"), x1: z.number().int(), y1: z.number().int(), x2: z.number().int(), y2: z.number().int() }).strict(),
]);

const rectSchema = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });

export const noteSchema = z.object({
  id: z.string(),
  seq: z.number(),
  videoId: z.string(),
  mediaSha256: z.string(),
  versionLabel: z.string(),
  fpsNum: z.number(),
  fpsDen: z.number(),
  kind: z.enum(NOTE_KINDS),
  frameIn: z.number().nullable(),
  frameOut: z.number().nullable(),
  frameLabel: z.string().nullable(),
  sectionId: z.string().nullable(),
  sectionOffset: z.number().nullable(),
  text: z.string(),
  category: z.enum(NOTE_CATEGORIES),
  rect: rectSchema.nullable(),
  shapes: z.array(shapeSchema),
  author: z.string().nullable(),
  visibility: z.enum(["internal", "client"]),
  status: z.enum(NOTE_STATUSES),
  statusNote: z.string().nullable(),
  fixedInSha: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sentAt: z.number().nullable(),
  sentThreadId: z.string().nullable(),
  resolvedAt: z.number().nullable(),
});

const versionSchema = z.object({
  sha256: z.string(),
  label: z.string(),
  width: z.number(),
  height: z.number(),
  fpsNum: z.number(),
  fpsDen: z.number(),
  frames: z.number(),
  firstSeenAt: z.number(),
  kept: z.enum(["clone", "copy", "none", "pruned"]),
  hasTimeline: z.boolean(),
});

const videoSchema = z.object({ id: z.string(), absPath: z.string(), name: z.string() });

/** What the player needs to map browser time to frames. */
const frameIndexSchema = z.object({
  sha256: z.string(),
  width: z.number(),
  height: z.number(),
  fps: z.object({ num: z.number(), den: z.number() }),
  vfr: z.boolean(),
  formatStart: z.number(),
  pts: z.array(z.number()),
});

const mediaSchema = z.object({ url: z.string(), expiresAtMs: z.number() });

export const openerSourceSchema = z
  .object({
    kind: z.enum(["host", "thread-storage", "workspace"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().nullable().optional(),
  })
  .strip();

const sendTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("new-thread"),
      sourceThreadId: z.string().nullable(),
      projectId: z.string().nullable(),
      environmentId: z.string().nullable(),
    })
    .strict(),
]);

const confidenceSchema = z.enum(["high", "medium", "low", "none"]);

const noteMappingSchema = z.object({
  noteId: z.string(),
  fromSha: z.string(),
  toSha: z.string(),
  frameIn: z.number().nullable(),
  frameOut: z.number().nullable(),
  method: z.enum(["manifest", "content", "same-file", "none"]),
  confidence: confidenceSchema,
  shifted: z.number(),
  unmappable: z.boolean(),
  manifest: z
    .object({
      frame: z.number(),
      frameOut: z.number().nullable(),
      by: z.enum(["scene", "section"]),
      id: z.string(),
      offset: z.number(),
      fit: z.enum(["exact", "resized", "clamped"]),
    })
    .nullable(),
  content: z
    .object({ frame: z.number(), frameOut: z.number().nullable(), confidence: confidenceSchema, shifted: z.number() })
    .nullable(),
});

const boxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const pixelDiffSchema = z.object({
  width: z.number(),
  height: z.number(),
  mean: z.number(),
  max: z.number(),
  changedShare: z.number(),
  box: boxSchema.nullable(),
  threshold: z.number(),
});

const reportSchema = z.object({
  from: versionSchema,
  to: versionSchema,
  content: z.object({
    shifts: z.array(
      z.object({
        oldFrame: z.number(),
        newFrame: z.number(),
        offsetBefore: z.number(),
        offsetAfter: z.number(),
        delta: z.number(),
        span: z.number(),
      }),
    ),
    changes: z.array(
      z.object({
        kind: z.enum(["changed", "slight", "inserted"]),
        from: z.number(),
        to: z.number(),
        oldFrom: z.number(),
        oldTo: z.number(),
        maxDistance: z.number(),
      }),
    ),
    removals: z.array(z.object({ from: z.number(), to: z.number(), at: z.number() })),
    matched: z.number(),
    ms: z.number(),
  }),
  boundaries: z
    .array(
      z.object({
        by: z.enum(["scene", "section"]),
        id: z.string(),
        edge: z.enum(["start", "end"]),
        oldFrame: z.number(),
        newFrame: z.number(),
        delta: z.number(),
      }),
    )
    .nullable(),
  spans: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }).nullable(),
});

const TEXT_MAX = 8000;
const idInput = z.object({ id: z.string() }).strict();

export const rpcContract = defineRpcContract({
  "video.open": {
    input: z.object({ path: z.string().min(1), source: openerSourceSchema }).strict(),
    output: z.object({
      video: videoSchema,
      version: versionSchema,
      index: frameIndexSchema,
      media: mediaSchema,
      /** Set when the tab was opened through `bb video-review open` (a .vreview file). */
      intent: z.object({ frame: z.number().nullable(), compare: z.string().nullable() }).nullable(),
    }),
  },
  "versions.list": {
    input: z.object({ videoId: z.string() }).strict(),
    output: z.object({ versions: z.array(versionSchema), currentSha: z.string().nullable() }),
  },
  /** Any version's frame index and a media URL (the file on disk, or the kept snapshot). */
  "versions.load": {
    input: z.object({ videoId: z.string(), sha256: z.string() }).strict(),
    output: z.object({ version: versionSchema, index: frameIndexSchema, media: mediaSchema }),
  },
  "versions.mediaUrl": {
    input: z.object({ videoId: z.string(), sha256: z.string(), refresh: z.boolean().optional() }).strict(),
    output: mediaSchema,
  },
  /** Frame maps between two versions: forward[i] = matching frame of `to` for frame i of `from`. */
  "versions.maps": {
    input: z.object({ videoId: z.string(), fromSha: z.string(), toSha: z.string() }).strict(),
    output: z.object({ forward: z.array(z.number()), backward: z.array(z.number()) }),
  },
  "versions.report": {
    input: z.object({ videoId: z.string(), fromSha: z.string(), toSha: z.string() }).strict(),
    output: reportSchema,
  },
  /** Where notes written on other versions land on `toSha`. */
  "notes.mapped": {
    input: z.object({ videoId: z.string(), toSha: z.string() }).strict(),
    output: z.object({ mappings: z.array(noteMappingSchema) }),
  },
  /** Pixel compare of a frame of A with its match (or a given frame) on B. */
  "compare.frames": {
    input: z
      .object({
        videoId: z.string(),
        aSha: z.string(),
        aFrame: z.number().int().min(0),
        bSha: z.string(),
        bFrame: z.number().int().min(0).optional(),
      })
      .strict(),
    output: z.object({
      aFrame: z.number(),
      bFrame: z.number(),
      diff: pixelDiffSchema,
      urls: z.object({ a: z.string(), b: z.string(), difference: z.string() }),
    }),
  },
  /**
   * The scrubber's files for one version (thumbnail sheets, black runs, a fast-seek proxy) and its section and scene
   * bands in frames. Built on first use (about a minute for a long render), then cached by sha256.
   */
  "scrub.assets": {
    input: z.object({ videoId: z.string(), sha256: z.string() }).strict(),
    output: z.object({
      proxyUrl: z.string(),
      sheetUrls: z.array(z.string()),
      step: z.number(),
      count: z.number(),
      cols: z.number(),
      rows: z.number(),
      w: z.number(),
      h: z.number(),
      /** Black runs as frames of this version, [first, last]. */
      black: z.array(z.tuple([z.number(), z.number()])),
      sections: z.array(z.object({ id: z.string(), start: z.number(), end: z.number() })),
      scenes: z.array(z.object({ id: z.string(), kind: z.string().optional(), start: z.number(), end: z.number() })),
      expiresAtMs: z.number(),
    }),
  },
  /** Cheap check for a re-render: the sha of the file on disk now. */
  "video.state": {
    input: z.object({ videoId: z.string() }).strict(),
    output: z.object({ sha256: z.string().nullable(), versions: z.array(versionSchema) }),
  },
  /** Reload after a re-render: the new frame index and a fresh media URL. */
  "video.reload": {
    input: z.object({ videoId: z.string() }).strict(),
    output: z.object({ version: versionSchema, index: frameIndexSchema, media: mediaSchema }),
  },
  "video.mediaUrl": {
    input: z.object({ videoId: z.string(), refresh: z.boolean().optional() }).strict(),
    output: mediaSchema,
  },
  "notes.list": {
    input: z.object({ videoId: z.string() }).strict(),
    output: z.object({
      notes: z.array(noteSchema),
      versions: z.array(versionSchema),
      /** URL prefix for a note's stills: `?note=<id>&kind=raw|annotated|crop`. */
      stillBase: z.string(),
    }),
  },
  "notes.create": {
    input: z
      .object({
        videoId: z.string(),
        /** The file the user was looking at; refused if the file changed since. */
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        kind: z.enum(NOTE_KINDS),
        frameIn: z.number().int().min(0).nullable(),
        frameOut: z.number().int().min(0).nullable(),
        text: z.string().trim().min(1).max(TEXT_MAX),
        category: z.enum(NOTE_CATEGORIES),
        shapes: z.array(shapeSchema).max(20),
      })
      .strict(),
    output: noteSchema,
  },
  "notes.update": {
    input: z
      .object({
        id: z.string(),
        text: z.string().trim().min(1).max(TEXT_MAX).optional(),
        category: z.enum(NOTE_CATEGORIES).optional(),
        shapes: z.array(shapeSchema).max(20).optional(),
      })
      .strict(),
    output: noteSchema,
  },
  "notes.delete": { input: idInput, output: z.object({ deleted: z.boolean() }) },
  "notes.reopen": { input: idInput, output: noteSchema },
  "notes.verify": { input: idInput, output: noteSchema },
  "notes.wontfix": {
    input: z.object({ id: z.string(), note: z.string().max(2000).optional() }).strict(),
    output: noteSchema,
  },
  "notes.send": {
    input: z
      .object({
        videoId: z.string(),
        /** Omit to send every draft of the video. */
        ids: z.array(z.string()).max(500).optional(),
        target: sendTargetSchema,
      })
      .strict(),
    output: z.object({ threadId: z.string(), sent: z.number() }),
  },
  "notes.handoffPrompt": {
    input: z.object({ videoId: z.string(), ids: z.array(z.string()).max(500).optional() }).strict(),
    output: z.object({ prompt: z.string(), ids: z.array(z.string()) }),
  },
  "notes.markSent": {
    input: z.object({ ids: z.array(z.string()).min(1).max(500), threadId: z.string().nullable() }).strict(),
    output: z.object({ sent: z.number() }),
  },
});

export type RpcContract = typeof rpcContract;
export type FrameIndexDto = z.infer<typeof frameIndexSchema>;
export type MediaDto = z.infer<typeof mediaSchema>;
export type NoteMappingDto = z.infer<typeof noteMappingSchema>;
export type ReportDto = z.infer<typeof reportSchema>;
export type PixelDiffDto = z.infer<typeof pixelDiffSchema>;
