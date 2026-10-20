import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  frameAtTime,
  frameLabel,
  probeFrames,
  seekTimeForFrame,
  stillArgs,
  timecode,
  type FrameIndex,
} from "../lib/frames.ts";

const dir = mkdtempSync(join(tmpdir(), "vr-frames-"));

function ffmpeg(args: string[]): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 512 * 1024 * 1024 });
}

// Small fixtures: every frame differs (testsrc2 moves), so a wrong frame is visible.
function make(name: string, extra: string[], rate = "30"): string {
  const out = join(dir, name);
  ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=${rate}:duration=6`,
    ...extra,
    "-c:v", "libx264", "-g", "48", "-bf", "2", "-pix_fmt", "yuv420p", "-y", out,
  ]);
  return out;
}

const fixtures = {
  cfr30: make("cfr30.mp4", []),
  ntsc: make("ntsc.mp4", [], "30000/1001"),
  offset: make("offset.mp4", ["-output_ts_offset", "1.5"]),
  vfr: make("vfr.mp4", ["-vf", "setpts='N/30/TB+if(gte(N,60),0.02*(N-59),0)/TB'", "-fps_mode", "passthrough"]),
};

function md5(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

function exactFrame(path: string, n: number): string {
  return md5(ffmpeg(["-i", path, "-map", "0:v:0", "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]));
}

function stillFrame(index: FrameIndex, path: string, n: number): string {
  const args = stillArgs(index, path, n, "-");
  const outAt = args.indexOf("-y");
  const base = args.slice(0, outAt).filter((a) => a !== "-v" && a !== "error");
  return md5(ffmpeg([...base, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]));
}

for (const [name, path] of Object.entries(fixtures)) {
  test(`${name}: still extraction matches the exact frame selector`, async () => {
    const index = await probeFrames(path);
    const count = index.pts.length;
    const picks = [0, 1, 2, 47, 48, 49, 60, 61, Math.floor(count / 2), count - 2, count - 1];
    for (const n of picks) {
      assert.equal(stillFrame(index, path, n), exactFrame(path, n), `frame ${n}`);
    }
  });

  test(`${name}: seek time maps back to the same frame`, async () => {
    const index = await probeFrames(path);
    for (let n = 0; n < index.pts.length; n++) {
      assert.equal(frameAtTime(index, seekTimeForFrame(index, n)), n);
      assert.equal(frameAtTime(index, index.pts[n]), n, "exact pts is that frame");
    }
  });
}

test("probe reports rate, offset and vfr", async () => {
  const cfr = await probeFrames(fixtures.cfr30);
  assert.deepEqual(cfr.fps, { num: 30, den: 1 });
  assert.equal(cfr.vfr, false);
  assert.equal(cfr.pts.length, 180);
  assert.match(cfr.sha256, /^[0-9a-f]{64}$/);

  const ntsc = await probeFrames(fixtures.ntsc);
  assert.deepEqual(ntsc.fps, { num: 30000, den: 1001 });

  const off = await probeFrames(fixtures.offset);
  assert.ok(off.pts[0] > 1.4, `offset start ${off.pts[0]}`);

  const vfr = await probeFrames(fixtures.vfr);
  assert.equal(vfr.vfr, true);
});

test("timecode and label", async () => {
  const index = await probeFrames(fixtures.cfr30);
  assert.equal(timecode(index, 0), "00:00:00:00");
  assert.equal(timecode(index, 95), "00:00:03:05");
  assert.equal(frameLabel(index, 95, "v7"), "v7 00:00:03:05 (95)");
  assert.equal(timecode(index, 10_000), timecode(index, 179), "clamped to the last frame");
});

test("time before the first frame is frame 0; time past the end is the last frame", async () => {
  const index = await probeFrames(fixtures.offset);
  assert.equal(frameAtTime(index, 0), 0);
  assert.equal(frameAtTime(index, 1e6), index.pts.length - 1);
});
