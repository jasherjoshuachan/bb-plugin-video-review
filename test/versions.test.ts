import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffRgb } from "../lib/compare.ts";
import { sha256File } from "../lib/frames.ts";
import { boundaryDeltas, mapByTimeline, parseTimeline, spanChanges } from "../lib/timeline.ts";
import { keepSnapshot, snapshotPath, snapshotsToPrune } from "../lib/versions.ts";
import type { NoteStatus } from "../lib/types.ts";

const v1 = {
  fps: 25,
  duration: 20,
  sections: [
    { id: "intro", t0: 0, t1: 8 },
    { id: "body", t0: 8, t1: 20 },
  ],
  scenes: [
    { id: "hook", kind: "avatar", t0: 0, t1: 4 },
    { id: "card", kind: "card", t0: 4, t1: 8 },
    { id: "demo", kind: "content", t0: 8, t1: 20 },
  ],
};
// The card got 2 frames shorter, so everything after it is 2 frames earlier.
const v2 = {
  ...v1,
  duration: 19.92,
  sections: [
    { id: "intro", t0: 0, t1: 7.92 },
    { id: "body", t0: 7.92, t1: 19.92 },
  ],
  scenes: [
    { id: "hook", kind: "avatar", t0: 0, t1: 4 },
    { id: "card", kind: "card", t0: 4, t1: 7.92 },
    { id: "demo", kind: "content", t0: 7.92, t1: 19.92 },
  ],
};

test("timeline: maps by scene and offset; flags resized and clamped spans", () => {
  const a = parseTimeline(v1, 500);
  const b = parseTimeline(v2, 498);
  const demo = mapByTimeline(a, b, 300);
  assert.deepEqual(demo, { frame: 298, by: "scene", id: "demo", offset: 100, fit: "exact" });
  const inCard = mapByTimeline(a, b, 110);
  assert.equal(inCard?.fit, "resized");
  assert.equal(inCard?.frame, 110);
  const lastCardFrame = mapByTimeline(a, b, 199);
  assert.equal(lastCardFrame?.fit, "clamped");
  assert.equal(lastCardFrame?.frame, 197);
});

test("timeline: edges that moved, in frames", () => {
  const deltas = boundaryDeltas(parseTimeline(v1), parseTimeline(v2));
  const card = deltas.find((d) => d.by === "scene" && d.id === "card" && d.edge === "end");
  assert.deepEqual(card, { by: "scene", id: "card", edge: "end", oldFrame: 200, newFrame: 198, delta: -2 });
  assert.ok(!deltas.some((d) => d.id === "hook"));
  assert.deepEqual(spanChanges(parseTimeline(v1), parseTimeline(v2)), { added: [], removed: [] });
});

test("timeline: refuses a manifest for another render and malformed ones", () => {
  assert.throws(() => parseTimeline(v1, 900), /belongs to another render/);
  assert.throws(() => parseTimeline({ fps: 25 }), /sections" or "scenes/);
  assert.throws(() => parseTimeline({ fps: 25, scenes: [{ id: "a", t0: 2, t1: 1 }] }), /t0 < t1/);
  assert.throws(() => parseTimeline({ fps: 25, scenes: [{ id: "a", t0: 0, t1: 1 }, { id: "a", t0: 1, t1: 2 }] }), /twice/);
  assert.throws(() => parseTimeline([]), /JSON object/);
});

const statuses = (s: NoteStatus) => s;

test("prune: keeps the current file, the previous version, and every version an open note needs", () => {
  const versions = ["a", "b", "c", "d", "e"].map((sha256, order) => ({ sha256, order, kept: "clone" as const }));
  const notes = [
    { mediaSha256: "a", fixedInSha: null, status: statuses("verified") },
    { mediaSha256: "b", fixedInSha: "c", status: statuses("fixed") },
    { mediaSha256: "a", fixedInSha: null, status: statuses("wontfix") },
  ];
  // current is e, previous is d; b (open note) and c (its fix) stay; a goes.
  assert.deepEqual(snapshotsToPrune(versions, notes, "e"), ["a"]);
  // A draft on a keeps a.
  assert.deepEqual(snapshotsToPrune(versions, [...notes, { mediaSha256: "a", fixedInSha: null, status: statuses("draft") }], "e"), []);
  // Snapshots never kept or already pruned are not pruned again.
  assert.deepEqual(snapshotsToPrune([{ sha256: "a", order: 0, kept: "none" }, { sha256: "z", order: 1, kept: "pruned" }], [], null), []);
});

test("prune: when the file is gone, the newest version still counts as the previous one", () => {
  const versions = ["a", "b"].map((sha256, order) => ({ sha256, order, kept: "clone" as const }));
  assert.deepEqual(snapshotsToPrune(versions, [], null), ["a"]);
});

test("snapshot: kept as a verified clone (or copy) named by sha", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vr-keep-"));
  const source = join(dir, "render.mp4");
  writeFileSync(source, Buffer.alloc(1024 * 64, 7));
  const sha = await sha256File(source);
  const kept = await keepSnapshot(source, sha, dir, 1e9);
  assert.ok(kept.kept === "clone" || kept.kept === "copy");
  assert.equal(kept.path, snapshotPath(dir, sha));
  assert.equal(await sha256File(kept.path!), sha);
  // The render is rewritten in place: the snapshot keeps the old bytes.
  writeFileSync(source, Buffer.alloc(1024 * 64, 9));
  assert.equal(await sha256File(kept.path!), sha);
  // Asking again reuses it.
  assert.equal((await keepSnapshot(source, sha, dir, 1e9)).path, kept.path);
});

test("snapshot: a sha that does not match the file is not kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vr-keep-"));
  const source = join(dir, "render.mp4");
  writeFileSync(source, "abc");
  const result = await keepSnapshot(source, "0".repeat(64), dir, 1e9);
  assert.equal(result.kept, "none");
  assert.equal(existsSync(snapshotPath(dir, "0".repeat(64))), false);
});

test("pixel diff: numbers and the box around what moved", () => {
  const w = 8;
  const h = 6;
  const a = new Uint8Array(w * h * 3);
  const b = new Uint8Array(w * h * 3);
  // A 2x2 white square at (2,1) in A, moved one pixel right in B.
  for (const [x, y] of [[2, 1], [3, 1], [2, 2], [3, 2]]) a.fill(255, (y * w + x) * 3, (y * w + x) * 3 + 3);
  for (const [x, y] of [[3, 1], [4, 1], [3, 2], [4, 2]]) b.fill(255, (y * w + x) * 3, (y * w + x) * 3 + 3);
  const { diff, image } = diffRgb(a, b, w, h);
  assert.deepEqual(diff.box, { x: 2, y: 1, w: 3, h: 2 });
  assert.equal(diff.max, 255);
  assert.equal(diff.changedShare, Math.round((4 / 48) * 10000) / 10000);
  assert.equal(image[1 * w + 2], 255);
  assert.equal(image[0], 0);
  const same = diffRgb(a, a, w, h).diff;
  assert.equal(same.box, null);
  assert.equal(same.mean, 0);
  assert.throws(() => diffRgb(a, new Uint8Array(3), w, h), /differ in size/);
});
