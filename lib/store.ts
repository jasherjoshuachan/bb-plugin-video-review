// Review state in the plugin's own SQLite database: one row per reviewed
// video path, one per version of it (keyed by sha256), and one per note.
// The video file itself is never modified.
//
// Adapted from Doc Review's src/store.ts (MIT, (c) 2026 Foma); see NOTICE.
import { createHash, randomBytes } from "node:crypto";
import { assertTransition, type Actor } from "./status.ts";
import type {
  Note,
  NoteCategory,
  NoteKind,
  NoteStatus,
  PixelRect,
  ReviewVideo,
  Shape,
  VideoVersion,
} from "./types.ts";

/** The subset of better-sqlite3 this module uses. */
export interface Db {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

/** Append-only: never edit or reorder a shipped statement. */
export const MIGRATIONS = [
  `CREATE TABLE videos (
     id TEXT PRIMARY KEY,
     host_id TEXT,
     abs_path TEXT NOT NULL,
     next_seq INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE versions (
     video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
     sha256 TEXT NOT NULL,
     label TEXT NOT NULL,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     fps_num INTEGER NOT NULL,
     fps_den INTEGER NOT NULL,
     frames INTEGER NOT NULL,
     first_seen_at INTEGER NOT NULL,
     PRIMARY KEY (video_id, sha256)
   )`,
  `CREATE TABLE notes (
     id TEXT PRIMARY KEY,
     video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     media_sha256 TEXT NOT NULL,
     version_label TEXT NOT NULL,
     fps_num INTEGER NOT NULL,
     fps_den INTEGER NOT NULL,
     kind TEXT NOT NULL,
     frame_in INTEGER,
     frame_out INTEGER,
     frame_label TEXT,
     section_id TEXT,
     section_offset INTEGER,
     text TEXT NOT NULL,
     category TEXT NOT NULL,
     rect TEXT,
     shapes TEXT NOT NULL DEFAULT '[]',
     author TEXT,
     visibility TEXT NOT NULL DEFAULT 'internal',
     status TEXT NOT NULL,
     status_note TEXT,
     fixed_in_sha TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     sent_at INTEGER,
     sent_thread_id TEXT,
     resolved_at INTEGER
   )`,
  `CREATE INDEX notes_video ON notes(video_id, seq)`,
  `CREATE INDEX notes_status ON notes(status, sent_thread_id)`,
  // Step 2: kept snapshots of older renders and their render manifests.
  `ALTER TABLE versions ADD COLUMN kept TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE versions ADD COLUMN snapshot_path TEXT`,
  `ALTER TABLE versions ADD COLUMN timeline TEXT`,
];

export interface VideoRow {
  id: string;
  hostId: string | null;
  absPath: string;
}

interface RawVideo {
  id: string;
  host_id: string | null;
  abs_path: string;
}

interface RawVersion {
  sha256: string;
  label: string;
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  frames: number;
  first_seen_at: number;
  kept: string;
  snapshot_path: string | null;
  timeline: string | null;
}

interface RawNote {
  id: string;
  video_id: string;
  seq: number;
  media_sha256: string;
  version_label: string;
  fps_num: number;
  fps_den: number;
  kind: NoteKind;
  frame_in: number | null;
  frame_out: number | null;
  frame_label: string | null;
  section_id: string | null;
  section_offset: number | null;
  text: string;
  category: NoteCategory;
  rect: string | null;
  shapes: string;
  author: string | null;
  visibility: "internal" | "client";
  status: NoteStatus;
  status_note: string | null;
  fixed_in_sha: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  sent_thread_id: string | null;
  resolved_at: number | null;
}

export interface NoteWithVideo extends Note {
  video: VideoRow;
}

export interface NewNote {
  videoId: string;
  mediaSha256: string;
  versionLabel: string;
  fpsNum: number;
  fpsDen: number;
  kind: NoteKind;
  frameIn: number | null;
  frameOut: number | null;
  frameLabel: string | null;
  text: string;
  category: NoteCategory;
  rect: PixelRect | null;
  shapes: Shape[];
  author?: string | null;
}

/** Stable id for a video path: the same path on the same host is the same video. */
export function videoIdFor(hostId: string | null, absPath: string): string {
  const digest = createHash("sha256").update(`${hostId ?? ""}\u0000${absPath}`).digest("hex");
  return `v_${digest.slice(0, 16)}`;
}

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function newNoteId(): string {
  let id = "n_";
  for (const byte of randomBytes(6)) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

function toVideo(raw: RawVideo): VideoRow {
  return { id: raw.id, hostId: raw.host_id, absPath: raw.abs_path };
}

function toVersion(raw: RawVersion): VideoVersion {
  return {
    sha256: raw.sha256,
    label: raw.label,
    width: raw.width,
    height: raw.height,
    fpsNum: raw.fps_num,
    fpsDen: raw.fps_den,
    frames: raw.frames,
    firstSeenAt: raw.first_seen_at,
    kept: (raw.kept ?? "none") as VideoVersion["kept"],
    hasTimeline: raw.timeline !== null && raw.timeline !== undefined,
  };
}

function toNote(raw: RawNote): Note {
  return {
    id: raw.id,
    seq: raw.seq,
    videoId: raw.video_id,
    mediaSha256: raw.media_sha256,
    versionLabel: raw.version_label,
    fpsNum: raw.fps_num,
    fpsDen: raw.fps_den,
    kind: raw.kind,
    frameIn: raw.frame_in,
    frameOut: raw.frame_out,
    frameLabel: raw.frame_label,
    sectionId: raw.section_id,
    sectionOffset: raw.section_offset,
    text: raw.text,
    category: raw.category,
    rect: raw.rect ? (JSON.parse(raw.rect) as PixelRect) : null,
    shapes: JSON.parse(raw.shapes) as Shape[],
    author: raw.author,
    visibility: raw.visibility,
    status: raw.status,
    statusNote: raw.status_note,
    fixedInSha: raw.fixed_in_sha,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    sentAt: raw.sent_at,
    sentThreadId: raw.sent_thread_id,
    resolvedAt: raw.resolved_at,
  };
}

export function videoName(absPath: string): string {
  const parts = absPath.split("/");
  return parts[parts.length - 1] ?? absPath;
}

export function toReviewVideo(row: VideoRow): ReviewVideo {
  return { id: row.id, absPath: row.absPath, name: videoName(row.absPath) };
}

export class ReviewStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  upsertVideo(hostId: string | null, absPath: string): VideoRow {
    const id = videoIdFor(hostId, absPath);
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO videos (id, host_id, abs_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(id, hostId, absPath, now, now);
    return { id, hostId, absPath };
  }

  getVideo(id: string): VideoRow | null {
    const raw = this.db.prepare(`SELECT * FROM videos WHERE id = ?`).get(id) as RawVideo | undefined;
    return raw ? toVideo(raw) : null;
  }

  findVideosByPath(absPath: string): VideoRow[] {
    return (this.db.prepare(`SELECT * FROM videos WHERE abs_path = ?`).all(absPath) as RawVideo[]).map(toVideo);
  }

  /** Records a version of the video, labelled v1, v2, … in the order first seen. */
  registerVersion(
    videoId: string,
    info: { sha256: string; width: number; height: number; fpsNum: number; fpsDen: number; frames: number },
  ): VideoVersion {
    const existing = this.getVersion(videoId, info.sha256);
    if (existing) return existing;
    const register = this.db.transaction(() => {
      const { count } = this.db
        .prepare(`SELECT COUNT(*) AS count FROM versions WHERE video_id = ?`)
        .get(videoId) as { count: number };
      this.db
        .prepare(
          `INSERT OR IGNORE INTO versions
             (video_id, sha256, label, width, height, fps_num, fps_den, frames, first_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(videoId, info.sha256, `v${count + 1}`, info.width, info.height, info.fpsNum, info.fpsDen, info.frames, this.now());
    });
    register();
    return this.getVersion(videoId, info.sha256)!;
  }

  getVersion(videoId: string, sha256: string): VideoVersion | null {
    const raw = this.db
      .prepare(`SELECT * FROM versions WHERE video_id = ? AND sha256 = ?`)
      .get(videoId, sha256) as RawVersion | undefined;
    return raw ? toVersion(raw) : null;
  }

  /** A version by its label (v1, v2, …) or a sha256 prefix of at least 8 characters. */
  findVersion(videoId: string, ref: string): VideoVersion | null {
    const wanted = ref.trim().toLowerCase();
    const all = this.listVersions(videoId);
    const byLabel = all.find((v) => v.label === wanted);
    if (byLabel) return byLabel;
    if (/^[0-9a-f]{8,64}$/.test(wanted)) {
      const matches = all.filter((v) => v.sha256.startsWith(wanted));
      if (matches.length === 1) return matches[0];
    }
    return null;
  }

  setKept(videoId: string, sha256: string, kept: VideoVersion["kept"], snapshotPath: string | null): void {
    this.db
      .prepare(`UPDATE versions SET kept = ?, snapshot_path = ? WHERE video_id = ? AND sha256 = ?`)
      .run(kept, snapshotPath, videoId, sha256);
  }

  snapshotOf(videoId: string, sha256: string): string | null {
    const row = this.db
      .prepare(`SELECT snapshot_path FROM versions WHERE video_id = ? AND sha256 = ? AND kept IN ('clone', 'copy')`)
      .get(videoId, sha256) as { snapshot_path: string | null } | undefined;
    return row?.snapshot_path ?? null;
  }

  /** Stores a render manifest for one version (raw JSON text, already validated). */
  setTimeline(videoId: string, sha256: string, json: string | null): void {
    this.db.prepare(`UPDATE versions SET timeline = ? WHERE video_id = ? AND sha256 = ?`).run(json, videoId, sha256);
  }

  timelineOf(videoId: string, sha256: string): string | null {
    const row = this.db.prepare(`SELECT timeline FROM versions WHERE video_id = ? AND sha256 = ?`).get(videoId, sha256) as
      | { timeline: string | null }
      | undefined;
    return row?.timeline ?? null;
  }

  listVersions(videoId: string): VideoVersion[] {
    return (
      this.db.prepare(`SELECT * FROM versions WHERE video_id = ? ORDER BY first_seen_at, rowid`).all(videoId) as RawVersion[]
    ).map(toVersion);
  }

  listNotes(videoId: string): Note[] {
    return (this.db.prepare(`SELECT * FROM notes WHERE video_id = ? ORDER BY seq`).all(videoId) as RawNote[]).map(toNote);
  }

  getNote(id: string): NoteWithVideo | null {
    const raw = this.db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as RawNote | undefined;
    if (!raw) return null;
    const video = this.getVideo(raw.video_id);
    return video ? { ...toNote(raw), video } : null;
  }

  /** Notes across videos, for the CLI. */
  queryNotes(filter: { statuses: NoteStatus[]; threadId?: string | null; videoIds?: string[]; limit: number }): NoteWithVideo[] {
    const clauses = [`status IN (${filter.statuses.map(() => "?").join(", ")})`];
    const params: unknown[] = [...filter.statuses];
    if (filter.threadId) {
      clauses.push(`sent_thread_id = ?`);
      params.push(filter.threadId);
    }
    if (filter.videoIds) {
      if (filter.videoIds.length === 0) return [];
      clauses.push(`video_id IN (${filter.videoIds.map(() => "?").join(", ")})`);
      params.push(...filter.videoIds);
    }
    params.push(filter.limit);
    const rows = this.db
      .prepare(`SELECT * FROM notes WHERE ${clauses.join(" AND ")} ORDER BY video_id, seq LIMIT ?`)
      .all(...params) as RawNote[];
    const videos = new Map<string, VideoRow | null>();
    const out: NoteWithVideo[] = [];
    for (const raw of rows) {
      if (!videos.has(raw.video_id)) videos.set(raw.video_id, this.getVideo(raw.video_id));
      const video = videos.get(raw.video_id);
      if (video) out.push({ ...toNote(raw), video });
    }
    return out;
  }

  createNote(input: NewNote): Note {
    const create = this.db.transaction(() => {
      const video = this.db.prepare(`SELECT next_seq FROM videos WHERE id = ?`).get(input.videoId) as
        | { next_seq: number }
        | undefined;
      if (!video) throw new Error(`Unknown video ${input.videoId}`);
      const id = newNoteId();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO notes (id, video_id, seq, media_sha256, version_label, fps_num, fps_den, kind,
             frame_in, frame_out, frame_label, text, category, rect, shapes, author, status,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          id,
          input.videoId,
          video.next_seq,
          input.mediaSha256,
          input.versionLabel,
          input.fpsNum,
          input.fpsDen,
          input.kind,
          input.frameIn,
          input.frameOut,
          input.frameLabel,
          input.text,
          input.category,
          input.rect ? JSON.stringify(input.rect) : null,
          JSON.stringify(input.shapes),
          input.author ?? null,
          now,
          now,
        );
      this.db.prepare(`UPDATE videos SET next_seq = next_seq + 1 WHERE id = ?`).run(input.videoId);
      return id;
    });
    return this.requireNote(create());
  }

  /** Edits text, category or markup; an edited note goes back to draft so it is sent again. */
  updateNote(id: string, patch: { text?: string; category?: NoteCategory; shapes?: Shape[]; rect?: PixelRect | null }): Note {
    const current = this.requireNote(id);
    const next = {
      text: patch.text ?? current.text,
      category: patch.category ?? current.category,
      shapes: patch.shapes ?? current.shapes,
      rect: patch.rect === undefined ? current.rect : patch.rect,
    };
    const backToDraft = current.status !== "draft";
    if (backToDraft) assertTransition(current.status, "draft", "user");
    this.db
      .prepare(
        `UPDATE notes SET text = ?, category = ?, shapes = ?, rect = ?, updated_at = ?,
           status = 'draft', resolved_at = NULL
         WHERE id = ?`,
      )
      .run(next.text, next.category, JSON.stringify(next.shapes), next.rect ? JSON.stringify(next.rect) : null, this.now(), id);
    return this.requireNote(id);
  }

  deleteNote(id: string): boolean {
    return this.db.prepare(`DELETE FROM notes WHERE id = ?`).run(id).changes > 0;
  }

  markSent(ids: string[], threadId: string | null): number {
    const now = this.now();
    const run = this.db.transaction(() => {
      let changed = 0;
      for (const id of ids) {
        const note = this.getNote(id);
        if (!note) continue;
        assertTransition(note.status, "sent", "user");
        changed += this.db
          .prepare(
            `UPDATE notes SET status = 'sent', sent_at = ?, sent_thread_id = ?, status_note = NULL,
               fixed_in_sha = NULL, resolved_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(now, threadId, now, id).changes;
      }
      return changed;
    });
    return run();
  }

  /** The agent fixed the note in the render whose sha256 is `fixedInSha`. */
  markFixed(id: string, fixedInSha: string, note: string | null): Note {
    return this.transition(id, "fixed", "agent", { statusNote: note, fixedInSha, resolved: true });
  }

  /** The agent answered instead of fixing. */
  markQuestion(id: string, note: string): Note {
    return this.transition(id, "question", "agent", { statusNote: note, fixedInSha: null, resolved: false });
  }

  verify(id: string): Note {
    return this.transition(id, "verified", "user", { resolved: true });
  }

  wontfix(id: string, note: string | null): Note {
    return this.transition(id, "wontfix", "user", { statusNote: note, resolved: true });
  }

  /** Back to draft so it can be edited and sent again; the agent's note stays visible. */
  reopen(id: string): Note {
    return this.transition(id, "draft", "user", { resolved: false });
  }

  private transition(
    id: string,
    to: NoteStatus,
    actor: Actor,
    fields: { statusNote?: string | null; fixedInSha?: string | null; resolved: boolean },
  ): Note {
    const note = this.requireNote(id);
    assertTransition(note.status, to, actor);
    const now = this.now();
    this.db
      .prepare(
        `UPDATE notes SET status = ?, status_note = ?, fixed_in_sha = ?, resolved_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        to,
        fields.statusNote === undefined ? note.statusNote : fields.statusNote,
        fields.fixedInSha === undefined ? note.fixedInSha : fields.fixedInSha,
        fields.resolved ? now : null,
        now,
        id,
      );
    return this.requireNote(id);
  }

  private requireNote(id: string): Note {
    const found = this.getNote(id);
    if (!found) throw new Error(`No note with id ${id}`);
    const { video: _video, ...note } = found;
    return note;
  }
}
