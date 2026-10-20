// Shared types for notes and videos. Pure: the player imports these too.

export const NOTE_KINDS = ["general", "frame", "range"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_CATEGORIES = ["cut", "audio", "pip", "text", "caption", "timing", "other"] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

/**
 * draft -> sent -> fixed (agent, with the new file's sha) -> verified (user only).
 * question: the agent answered instead of fixing. wontfix: the user closed it.
 */
export const NOTE_STATUSES = ["draft", "sent", "fixed", "verified", "question", "wontfix"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** A rectangle in source pixels (the video's own resolution). */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Shape =
  | { type: "box"; x: number; y: number; w: number; h: number }
  | { type: "arrow"; x1: number; y1: number; x2: number; y2: number };

export interface Note {
  id: string;
  seq: number;
  videoId: string;
  /** The exact file the note was written on. */
  mediaSha256: string;
  versionLabel: string;
  fpsNum: number;
  fpsDen: number;
  kind: NoteKind;
  /** 0-based frame index; null for a general note. */
  frameIn: number | null;
  /** Last frame of a range (inclusive); equals frameIn for a frame note. */
  frameOut: number | null;
  /** Version-stamped label, e.g. `v2 00:00:36:22 (922)`. */
  frameLabel: string | null;
  sectionId: string | null;
  sectionOffset: number | null;
  text: string;
  category: NoteCategory;
  rect: PixelRect | null;
  shapes: Shape[];
  author: string | null;
  visibility: "internal" | "client";
  status: NoteStatus;
  statusNote: string | null;
  fixedInSha: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  sentThreadId: string | null;
  resolvedAt: number | null;
}

export interface VideoVersion {
  sha256: string;
  label: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  frames: number;
  firstSeenAt: number;
  /** Whether an older render stays viewable: clone or copy kept, none, or pruned once no note needed it. */
  kept: "clone" | "copy" | "none" | "pruned";
  /** A render manifest (sections and scenes) is stored for this version. */
  hasTimeline: boolean;
}

export interface ReviewVideo {
  id: string;
  absPath: string;
  name: string;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Whether a note was written on a different file than the one on disk now. */
export function isStale(note: Pick<Note, "mediaSha256">, currentSha: string | null): boolean {
  return currentSha !== null && note.mediaSha256 !== currentSha;
}

/** Where a note points, for lists and the hand-off message. */
export function noteLocation(note: Pick<Note, "kind" | "frameLabel" | "frameIn" | "frameOut" | "versionLabel">): string {
  if (note.kind === "general" || note.frameIn === null) return `${note.versionLabel} whole video`;
  return note.frameLabel ?? `${note.versionLabel} frame ${note.frameIn}`;
}

export function describeShapes(shapes: readonly Shape[]): string | null {
  if (shapes.length === 0) return null;
  return shapes
    .map((shape) =>
      shape.type === "box"
        ? `box x=${shape.x} y=${shape.y} w=${shape.w} h=${shape.h} px`
        : `arrow from (${shape.x1}, ${shape.y1}) to (${shape.x2}, ${shape.y2}) px`,
    )
    .join("; ");
}
