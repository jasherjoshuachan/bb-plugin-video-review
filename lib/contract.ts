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

const TEXT_MAX = 8000;
const idInput = z.object({ id: z.string() }).strict();

export const rpcContract = defineRpcContract({
  "video.open": {
    input: z.object({ path: z.string().min(1), source: openerSourceSchema }).strict(),
    output: z.object({ video: videoSchema, version: versionSchema, index: frameIndexSchema, media: mediaSchema }),
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
