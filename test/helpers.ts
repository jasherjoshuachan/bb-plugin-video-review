import Database from "better-sqlite3";
import { MIGRATIONS, ReviewStore, type Db } from "../lib/store.ts";
import type { NoteCategory, NoteKind } from "../lib/types.ts";

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);

export function memoryStore(): ReviewStore {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return new ReviewStore(db as unknown as Db);
}

export function seed(store: ReviewStore, path = "/work/out/video.mp4") {
  const video = store.upsertVideo(null, path);
  const version = store.registerVersion(video.id, {
    sha256: SHA_A,
    width: 1920,
    height: 1080,
    fpsNum: 25,
    fpsDen: 1,
    frames: 12895,
  });
  const note = (overrides: { kind?: NoteKind; frameIn?: number | null; frameOut?: number | null; text?: string; category?: NoteCategory } = {}) =>
    store.createNote({
      videoId: video.id,
      mediaSha256: SHA_A,
      versionLabel: version.label,
      fpsNum: 25,
      fpsDen: 1,
      kind: overrides.kind ?? "frame",
      frameIn: overrides.frameIn === undefined ? 922 : overrides.frameIn,
      frameOut: overrides.frameOut === undefined ? 922 : overrides.frameOut,
      frameLabel: "v1 00:00:36:22 (922)",
      text: overrides.text ?? "Cut lands inside 'Code'",
      category: overrides.category ?? "cut",
      rect: null,
      shapes: [],
    });
  return { video, version, note };
}
