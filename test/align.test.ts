import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { align, alignmentReport, mapOldFrame, type Signatures } from "../lib/align.ts";
import { probeFrames, defaultTools } from "../lib/frames.ts";
import { signatures, SIGNATURE_HEIGHT, SIGNATURE_WIDTH } from "../lib/versions.ts";

const dims = { width: SIGNATURE_WIDTH, height: SIGNATURE_HEIGHT };
const dir = mkdtempSync(join(tmpdir(), "vr-align-"));

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", ...args]);
}

/** A 25 fps clip whose frames all differ (testsrc2 moves), re-encoded the way a render would be. */
function render(name: string, filter: string, extraInputs: string[] = []): string {
  const out = join(dir, name);
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=8",
    ...extraInputs,
    "-filter_complex", filter,
    "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "50", "-bf", "2", "-y", out,
  ]);
  return out;
}

async function sigs(file: string): Promise<Signatures> {
  const index = await probeFrames(file);
  return signatures(file, index.sha256, index.pts.length, dir, defaultTools);
}

const base = render("base.mp4", "[0:v]null[v]");
const reencoded = (() => {
  const out = join(dir, "reencoded.mp4");
  ffmpeg(["-i", base, "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p", "-y", out]);
  return out;
})();
// 10 frames of a different picture inserted after frame 60.
const inserted = render(
  "inserted.mp4",
  "[0:v]split[a][b];[a]trim=end_frame=60,setpts=PTS-STARTPTS[a1];[b]trim=start_frame=60,setpts=PTS-STARTPTS[b1];[1:v]trim=end_frame=10,setpts=PTS-STARTPTS[x];[a1][x][b1]concat=n=3:v=1[v]",
  ["-f", "lavfi", "-i", "mandelbrot=size=320x180:rate=25"],
);
// Frames 40-59 cut.
const removed = render("removed.mp4", "[0:v]select='not(between(n,40,59))',setpts=N/25/TB[v]");
// Played 10% faster (frames dropped evenly).
const faster = render("faster.mp4", "[0:v]setpts=PTS/1.1,fps=25[v]");

test("an identical render maps frame to frame with no shifts or changes", async () => {
  const al = align(await sigs(base), await sigs(reencoded), dims);
  for (const f of [0, 1, 50, 100, 199]) assert.equal(mapOldFrame(al, f).frame, f);
  const report = alignmentReport(al);
  assert.deepEqual(report.shifts, []);
  assert.deepEqual(report.changes.filter((c) => c.kind !== "slight"), []);
  assert.ok(report.matched > 0.99);
});

test("inserted frames: later frames move by the insert, the insert is reported", async () => {
  const al = align(await sigs(base), await sigs(inserted), dims);
  assert.equal(mapOldFrame(al, 30).frame, 30);
  assert.equal(mapOldFrame(al, 100).frame, 110);
  assert.equal(mapOldFrame(al, 100).shifted, 10);
  const report = alignmentReport(al);
  assert.equal(report.shifts.length, 1);
  assert.equal(report.shifts[0].delta, 10);
  assert.ok(Math.abs(report.shifts[0].oldFrame - 60) <= 1, `shift at ${report.shifts[0].oldFrame}`);
  const insert = report.changes.find((c) => c.kind === "inserted");
  assert.ok(insert, JSON.stringify(report.changes));
  assert.ok(insert.from >= 59 && insert.to <= 70 && insert.to - insert.from >= 7, JSON.stringify(insert));
});

test("removed frames: later frames move back, the cut is reported", async () => {
  const al = align(await sigs(base), await sigs(removed), dims);
  assert.equal(mapOldFrame(al, 20).frame, 20);
  assert.equal(mapOldFrame(al, 100).frame, 80);
  const report = alignmentReport(al);
  assert.equal(report.shifts.length, 1);
  assert.equal(report.shifts[0].delta, -20);
  const cut = report.removals[0];
  assert.ok(cut && cut.from >= 39 && cut.from <= 41 && cut.to >= 58 && cut.to <= 60, JSON.stringify(report.removals));
});

test("a speed change maps monotonically onto the shorter render", async () => {
  const a = await sigs(base);
  const b = await sigs(faster);
  const al = align(a, b, dims);
  let last = -1;
  for (let i = 0; i < a.count; i++) {
    assert.ok(al.oldToNew[i] >= last, `monotonic at ${i}`);
    last = al.oldToNew[i];
  }
  for (const f of [50, 110, 190]) {
    const expected = Math.round(f / 1.1);
    assert.ok(Math.abs(mapOldFrame(al, f).frame - expected) <= 1, `${f} -> ${mapOldFrame(al, f).frame}, expected ~${expected}`);
  }
});

test("pure sequences: a one-frame swap is a change, not a shift", () => {
  const size = 4;
  const frames = 60;
  const make = (swap: boolean): Signatures => {
    const data = new Uint8Array(frames * size);
    for (let i = 0; i < frames; i++) for (let k = 0; k < size; k++) data[i * size + k] = (i * 4 + k * 50) % 256;
    if (swap) data.fill(250, 30 * size, 31 * size);
    return { count: frames, size, data };
  };
  const al = align(make(false), make(true), { width: 2, height: 2 });
  const report = alignmentReport(al);
  assert.deepEqual(report.shifts, []);
  assert.equal(mapOldFrame(al, 45).frame, 45);
  assert.ok(report.changes.some((c) => c.from <= 30 && c.to >= 30), JSON.stringify(report.changes));
});
