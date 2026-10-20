import { test } from "node:test";
import assert from "node:assert/strict";
import { videoReviewCli } from "../lib/cli.ts";
import { memoryStore, seed, SHA_A, SHA_B } from "./helpers.ts";

function setup(onDisk: string | null = SHA_B) {
  const store = memoryStore();
  const seeded = seed(store);
  const changed: string[][] = [];
  const cli = videoReviewCli({
    store,
    onChanged: (ids) => changed.push(ids),
    currentSha: async () => onDisk,
    frameFiles: async (note, { current }) => ({
      frame: note.frameIn!,
      sha256: current ? (onDisk ?? SHA_A) : note.mediaSha256,
      files: [{ kind: "raw", path: `/tmp/${note.id}.png` }],
    }),
  });
  const run = (...argv: string[]) => cli.run(argv, { threadId: "thr_1", cwd: "/work" });
  return { store, cli, run, changed, ...seeded };
}

test("resolve refuses without --sha", async () => {
  const { run, note, store } = setup();
  const n = note();
  store.markSent([n.id], "thr_1");
  const result = await run("resolve", n.id, "--note", "done");
  assert.notEqual(result.exitCode, 0);
  assert.match(String(result.stderr), /sha/);
  assert.equal(store.getNote(n.id)!.status, "sent");
});

test("resolve refuses a malformed sha", async () => {
  const { run, note, store } = setup();
  const n = note();
  store.markSent([n.id], "thr_1");
  const result = await run("resolve", n.id, "--sha", "abc123");
  assert.notEqual(result.exitCode, 0);
  assert.match(String(result.stderr), /64-character/);
});

test("resolve refuses a sha that is not the file on disk", async () => {
  const { run, note, store } = setup(SHA_B);
  const n = note();
  store.markSent([n.id], "thr_1");
  const result = await run("resolve", n.id, "--sha", "c".repeat(64));
  assert.notEqual(result.exitCode, 0);
  assert.match(String(result.stderr), /does not match the file on disk/);
});

test("resolve refuses when nothing was re-rendered", async () => {
  const { run, note, store } = setup(SHA_A);
  const n = note();
  store.markSent([n.id], "thr_1");
  const result = await run("resolve", n.id, "--sha", SHA_A);
  assert.notEqual(result.exitCode, 0);
  assert.match(String(result.stderr), /nothing was re-rendered/);
});

test("resolve marks fixed with the new sha and publishes", async () => {
  const { run, note, store, changed, video } = setup(SHA_B);
  const n = note();
  store.markSent([n.id], "thr_1");
  const result = await run("resolve", n.id, "--sha", SHA_B.toUpperCase(), "--note", "cut moved to the word gap");
  assert.equal(result.exitCode, 0, String(result.stderr));
  const after = store.getNote(n.id)!;
  assert.equal(after.status, "fixed");
  assert.equal(after.fixedInSha, SHA_B);
  assert.equal(after.statusNote, "cut moved to the word gap");
  assert.deepEqual(changed, [[video.id]]);
});

test("resolve on a draft is refused (it was never sent)", async () => {
  const { run, note } = setup(SHA_B);
  const n = note();
  const result = await run("resolve", n.id, "--sha", SHA_B);
  assert.notEqual(result.exitCode, 0);
  assert.match(String(result.stderr), /cannot become fixed/);
});

test("there is no verify command", async () => {
  const { run, note, store } = setup(SHA_B);
  const n = note();
  store.markSent([n.id], "thr_1");
  const result = await run("verify", n.id);
  assert.notEqual(result.exitCode, 0);
  assert.equal(store.getNote(n.id)!.status, "sent");
});

test("reply needs --note and sets question", async () => {
  const { run, note, store } = setup();
  const n = note();
  store.markSent([n.id], "thr_1");
  const missing = await run("reply", n.id);
  assert.notEqual(missing.exitCode, 0);
  const ok = await run("reply", n.id, "--note", "Which word do you mean?");
  assert.equal(ok.exitCode, 0, String(ok.stderr));
  assert.equal(store.getNote(n.id)!.status, "question");
});

test("list defaults to notes sent to this thread", async () => {
  const { run, note, store } = setup();
  const a = note({ text: "first" });
  const b = note({ text: "second" });
  store.markSent([a.id], "thr_1");
  store.markSent([b.id], "thr_2");
  const result = await run("list");
  assert.equal(result.exitCode, 0);
  assert.ok(String(result.stdout).includes(a.id));
  assert.ok(!String(result.stdout).includes(b.id));
  const all = await run("list", "--all-threads", "--json");
  assert.equal(JSON.parse(String(all.stdout)).notes.length, 2);
});

test("frame prints the stills; a whole-video note has none", async () => {
  const { run, note } = setup();
  const n = note();
  const result = await run("frame", n.id);
  assert.equal(result.exitCode, 0);
  assert.ok(String(result.stdout).includes(`raw: /tmp/${n.id}.png`));
  const general = note({ kind: "general", frameIn: null, frameOut: null });
  const none = await run("frame", general.id);
  assert.notEqual(none.exitCode, 0);
});
