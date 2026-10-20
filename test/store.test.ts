import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition } from "../lib/status.ts";
import { NOTE_STATUSES } from "../lib/types.ts";
import { memoryStore, seed, SHA_A, SHA_B } from "./helpers.ts";

test("versions are labelled in the order first seen and are idempotent", () => {
  const store = memoryStore();
  const { video } = seed(store);
  const again = store.registerVersion(video.id, { sha256: SHA_A, width: 1920, height: 1080, fpsNum: 25, fpsDen: 1, frames: 1 });
  assert.equal(again.label, "v1");
  const second = store.registerVersion(video.id, { sha256: SHA_B, width: 1920, height: 1080, fpsNum: 25, fpsDen: 1, frames: 1 });
  assert.equal(second.label, "v2");
  assert.deepEqual(store.listVersions(video.id).map((v) => v.label), ["v1", "v2"]);
});

test("a note starts as a draft with a per-video sequence number", () => {
  const store = memoryStore();
  const { note } = seed(store);
  const first = note();
  const second = note({ kind: "range", frameIn: 100, frameOut: 140 });
  assert.equal(first.status, "draft");
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(second.frameOut, 140);
  assert.equal(first.mediaSha256, SHA_A);
});

test("the full loop: draft, sent, fixed by the agent, verified by the user", () => {
  const store = memoryStore();
  const { note } = seed(store);
  const n = note();
  assert.equal(store.markSent([n.id], "thr_1"), 1);
  const fixed = store.markFixed(n.id, SHA_B, "moved the cut 3 frames later");
  assert.equal(fixed.status, "fixed");
  assert.equal(fixed.fixedInSha, SHA_B);
  assert.ok(fixed.resolvedAt);
  const verified = store.verify(n.id);
  assert.equal(verified.status, "verified");
});

test("the agent can never verify, and cannot fix a draft", () => {
  for (const from of NOTE_STATUSES) assert.equal(canTransition(from, "verified", "agent"), false, from);
  const store = memoryStore();
  const { note } = seed(store);
  const n = note();
  assert.throws(() => store.markFixed(n.id, SHA_B, null), /cannot become fixed/);
});

test("the user cannot verify a note the agent has not fixed", () => {
  const store = memoryStore();
  const { note } = seed(store);
  const n = note();
  store.markSent([n.id], "thr_1");
  assert.throws(() => store.verify(n.id), /cannot become verified/);
});

test("a question goes back to the agent when re-sent, and editing reopens as draft", () => {
  const store = memoryStore();
  const { note } = seed(store);
  const n = note();
  store.markSent([n.id], "thr_1");
  const q = store.markQuestion(n.id, "Which word?");
  assert.equal(q.status, "question");
  assert.equal(q.statusNote, "Which word?");
  const edited = store.updateNote(n.id, { text: "The cut inside 'Code' at 0:36.9" });
  assert.equal(edited.status, "draft");
  assert.equal(edited.statusNote, "Which word?", "the agent's answer stays visible");
  store.markSent([n.id], "thr_1");
  assert.equal(store.getNote(n.id)!.statusNote, null);
});

test("query by status and thread for the CLI", () => {
  const store = memoryStore();
  const { note } = seed(store);
  const a = note();
  const b = note();
  note();
  store.markSent([a.id], "thr_1");
  store.markSent([b.id], "thr_2");
  assert.deepEqual(store.queryNotes({ statuses: ["sent"], threadId: "thr_1", limit: 10 }).map((n) => n.id), [a.id]);
  assert.equal(store.queryNotes({ statuses: ["draft"], limit: 10 }).length, 1);
  assert.equal(store.queryNotes({ statuses: ["sent"], videoIds: [], limit: 10 }).length, 0);
});

test("wontfix and reopen are the user's", () => {
  const store = memoryStore();
  const { note } = seed(store);
  const n = note();
  const closed = store.wontfix(n.id, "fine as is");
  assert.equal(closed.status, "wontfix");
  assert.equal(store.reopen(n.id).status, "draft");
});
