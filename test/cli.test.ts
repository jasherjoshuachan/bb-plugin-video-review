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

function setupStep2() {
  const store = memoryStore();
  const seeded = seed(store);
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const cli = videoReviewCli({
    store,
    onChanged: () => {},
    currentSha: async () => SHA_B,
    frameFiles: async () => ({ frame: 0, sha256: SHA_A, files: [] }),
    registerTimeline: async (file, text) => {
      calls.push({ fn: "timeline", args: [file, text] });
      return { label: "v1", sha256: SHA_A, sections: 2, scenes: 3 };
    },
    compareNote: async (note, to) => {
      calls.push({ fn: "compareNote", args: [note.id, to] });
      return { text: "compared", data: { ok: true } };
    },
    compareVersions: async (file, a, b, frame) => {
      calls.push({ fn: "compareVersions", args: [file, a, b, frame] });
      return { text: "report", data: { a, b } };
    },
    open: async (file, options) => {
      calls.push({ fn: "open", args: [file, options] });
      return "opened";
    },
  });
  return { store, cli, calls, ...seeded };
}

test("compare needs a note id or --file with two --versions", async () => {
  const { cli, calls, note } = setupStep2();
  const run = (...argv: string[]) => cli.run(argv, { threadId: "thr_1", cwd: "/work" });
  assert.match(String((await run("compare")).stderr), /note id, or --file/);
  assert.match(String((await run("compare", "--file", "out/v.mp4", "--versions", "v1")).stderr), /exactly two/);
  const n = note();
  assert.match(String((await run("compare", n.id, "--file", "x.mp4", "--versions", "v1,v2")).stderr), /not both/);
  assert.equal((await run("compare", n.id, "--to", "v2")).stdout, "compared");
  assert.equal((await run("compare", "--file", "out/v.mp4", "--versions", "v1 v2", "--frame", "12", "--json")).stdout, JSON.stringify({ a: "v1", b: "v2" }));
  assert.deepEqual(calls.map((c) => c.args), [
    [n.id, "v2"],
    ["/work/out/v.mp4", "v1", "v2", 12],
  ]);
});

test("compare refuses a whole-video note", async () => {
  const { cli, note } = setupStep2();
  const n = note({ kind: "general", frameIn: null, frameOut: null });
  const result = await cli.run(["compare", n.id], { threadId: "thr_1", cwd: "/work" });
  assert.match(String(result.stderr), /whole video/);
});

test("open needs a thread and resolves the path from the working directory", async () => {
  const { cli, calls } = setupStep2();
  const noThread = await cli.run(["open", "out/v.mp4"], { threadId: null, cwd: "/work" } as never);
  assert.match(String(noThread.stderr), /inside a bb thread/);
  const ok = await cli.run(["open", "out/v.mp4", "--frame", "40", "--compare", "v1"], { threadId: "thr_9", cwd: "/work" });
  assert.equal(ok.stdout, "opened");
  assert.deepEqual(calls.at(-1)?.args, ["/work/out/v.mp4", { threadId: "thr_9", frame: 40, compare: "v1" }]);
});

test("timeline reads the manifest file and reports a bad one", async () => {
  const { cli, calls } = setupStep2();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "vr-cli-"));
  writeFileSync(join(dir, "t.json"), '{"fps":25}');
  const ok = await cli.run(["timeline", "out/v.mp4", join(dir, "t.json")], { threadId: "thr_1", cwd: "/work" });
  assert.match(String(ok.stdout), /2 sections, 3 scenes/);
  assert.deepEqual(calls.at(-1)?.args, ["/work/out/v.mp4", '{"fps":25}']);
  const missing = await cli.run(["timeline", "out/v.mp4", join(dir, "nope.json")], { threadId: "thr_1", cwd: "/work" });
  assert.match(String(missing.stderr), /Cannot read/);
});
