import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHandoffMessage } from "../lib/message.ts";
import type { VideoVersion } from "../lib/types.ts";
import { memoryStore, seed, SHA_A, SHA_B } from "./helpers.ts";

function versions(store: ReturnType<typeof memoryStore>, videoId: string): Map<string, VideoVersion> {
  return new Map(store.listVersions(videoId).map((v) => [v.sha256, v]));
}

test("the message names the exact file, version, sha and each note's frame", () => {
  const store = memoryStore();
  const { video, version, note } = seed(store);
  const n = note();
  const r = note({ kind: "range", frameIn: 12099, frameOut: 12101, text: "Seam moved", category: "timing" });
  const text = buildHandoffMessage({
    absPath: video.absPath,
    current: version,
    notes: [n, r],
    versions: versions(store, video.id),
    imageNumbers: new Map([[n.id, [1, 2]]]),
    imagePaths: new Map([[r.id, ["/tmp/stills/r.png"]]]),
  });
  assert.match(text, /^Video review notes on `video\.mp4` — 2 to address\./);
  assert.ok(text.includes(`sha256 ${SHA_A}`));
  assert.ok(text.includes("1920x1080 · 25 fps (25/1) · 12895 frames"));
  assert.ok(text.includes(`[${n.id}] v1 00:00:36:22 (922) · cut · images 1, 2 attached`));
  assert.ok(text.includes("frames 12099–12101 (3 frames) · timing · images: `/tmp/stills/r.png`"));
  assert.ok(text.includes("bb video-review resolve <id> --sha <sha256>"));
  assert.ok(!text.includes("Written on"), "no stale warning on the current file");
});

test("a note written on an older cut is flagged with its version", () => {
  const store = memoryStore();
  const { video, note } = seed(store);
  const n = note();
  const v2 = store.registerVersion(video.id, { sha256: SHA_B, width: 1920, height: 1080, fpsNum: 25, fpsDen: 1, frames: 12890 });
  const text = buildHandoffMessage({
    absPath: video.absPath,
    current: v2,
    notes: [n],
    versions: versions(store, video.id),
    imageNumbers: new Map(),
    imagePaths: new Map(),
  });
  assert.ok(text.includes("Version: v2"));
  assert.match(text, /Written on v1 \(sha256 aaaaaaaaaaaa\), not the current v2/);
});

test("markup is spelled out in source pixels", () => {
  const store = memoryStore();
  const { video, version } = seed(store);
  const n = store.createNote({
    videoId: video.id,
    mediaSha256: SHA_A,
    versionLabel: "v1",
    fpsNum: 25,
    fpsDen: 1,
    kind: "frame",
    frameIn: 487,
    frameOut: 487,
    frameLabel: "v1 00:00:19:12 (487)",
    text: "Inset is off",
    category: "pip",
    rect: null,
    shapes: [{ type: "box", x: 1608, y: 734, w: 288, h: 216 }],
  });
  const text = buildHandoffMessage({
    absPath: video.absPath,
    current: version,
    notes: [n],
    versions: new Map(),
    imageNumbers: new Map(),
    imagePaths: new Map(),
  });
  assert.ok(text.includes("Marked: box x=1608 y=734 w=288 h=216 px"));
});
