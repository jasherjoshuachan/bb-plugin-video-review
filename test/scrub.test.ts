import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultTools } from "../lib/frames.ts";
import { VideoMedia } from "../lib/media.ts";
import {
  buildScrub,
  clampView,
  cutsOf,
  fit,
  follow,
  frameAtX,
  MIN_SPAN,
  nextCut,
  pan,
  parseBlack,
  shareAt,
  thumbStep,
  tileAt,
  zoom,
} from "../lib/scrub.ts";

test("thumbnail step: about 600 across the film, never under 0.25 s", () => {
  assert.equal(thumbStep(259.64), 0.43);
  assert.equal(thumbStep(30), 0.25);
  assert.equal(thumbStep(600), 1);
});

test("a time maps to its sheet and tile", () => {
  const meta = { step: 0.5, count: 250, cols: 10, rows: 10, w: 160, h: 90 };
  assert.deepEqual(tileAt(meta, 0), { n: 0, sheet: 0, x: 0, y: 0 });
  assert.deepEqual(tileAt(meta, 5.6), { n: 11, sheet: 0, x: 160, y: 90 });
  assert.deepEqual(tileAt(meta, 60), { n: 120, sheet: 1, x: 0, y: 180 });
  assert.equal(tileAt(meta, 999).n, 249, "past the end: the last tile");
});

test("zoom keeps the frame under the cursor in place, and never goes below the smallest window", () => {
  const total = 6491;
  const v = zoom(fit(total), 4, 0.25, total);
  assert.equal(Math.round(v.end - v.start), Math.round(total / 4));
  assert.ok(Math.abs(v.start + 0.25 * (v.end - v.start) - 0.25 * total) < 1e-6, "pivot stays at 25%");
  let tight = fit(total);
  for (let i = 0; i < 40; i++) tight = zoom(tight, 2, 0.5, total);
  assert.equal(tight.end - tight.start, MIN_SPAN);
  const out = zoom(v, 1 / 100, 0.5, total);
  assert.deepEqual(out, { start: 0, end: total }, "zooming out stops at the whole video");
});

test("pan and follow stay inside the video", () => {
  const total = 1000;
  const v = { start: 400, end: 500 };
  assert.deepEqual(pan(v, 1, total), { start: 500, end: 600 });
  assert.deepEqual(pan(v, 10, total), { start: 900, end: 1000 });
  assert.deepEqual(pan(v, -10, total), { start: 0, end: 100 });
  assert.deepEqual(follow(v, 450, total), v, "a visible frame does not move the window");
  const moved = follow(v, 700, total);
  assert.ok(700 >= moved.start && 700 < moved.end);
  assert.deepEqual(clampView({ start: -50, end: 50 }, total), { start: 0, end: 100 });
});

test("x to frame and back", () => {
  const v = { start: 100, end: 200 };
  assert.equal(frameAtX(v, 0, 1000, 999), 100);
  assert.equal(frameAtX(v, 500, 1000, 999), 150);
  assert.equal(frameAtX(v, 5000, 1000, 999), 200, "clamped to the strip");
  assert.equal(shareAt(v, 150), 0.5);
});

test("scene cuts: next and previous, none past the ends", () => {
  const cuts = cutsOf([{ start: 0 }, { start: 120 }, { start: 300 }, { start: 120 }]);
  assert.deepEqual(cuts, [120, 300]);
  assert.equal(nextCut(cuts, 0, 1), 120);
  assert.equal(nextCut(cuts, 120, 1), 300);
  assert.equal(nextCut(cuts, 300, 1), null);
  assert.equal(nextCut(cuts, 200, -1), 120);
  assert.equal(nextCut(cuts, 120, -1), null);
});

test("blackdetect output parses to runs", () => {
  const stderr = "[blackdetect @ 0x1] black_start:1 black_end:1.48 black_duration:0.48\n[blackdetect @ 0x1] black_start:3.2 black_end:3.24";
  assert.deepEqual(parseBlack(stderr), [[1, 1.48], [3.2, 3.24]]);
});

test("building the files: sheets, a black run where the clip is black, a fast-seek proxy, cached by sha", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vr-scrub-"));
  const video = join(dir, "clip.mp4");
  // 4 s of test pattern with 0.48 s of black from 1.0 s.
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=4",
    "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,1,1.47)'",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", video,
  ]);
  const media = new VideoMedia(async () => defaultTools, join(dir, "stills"));
  const index = await media.index(video);
  const out = join(dir, "scrub");
  const info = { sha256: index.sha256, duration: 4, width: index.width, height: index.height };
  const meta = await buildScrub(defaultTools, video, out, info);
  assert.equal(meta.step, 0.25);
  assert.equal(meta.count, 16);
  assert.deepEqual(meta.sheets, ["sheet-001.jpg"]);
  assert.ok(existsSync(join(out, "sheet-001.jpg")));
  assert.equal(meta.h, 90);
  assert.equal(meta.black.length, 1, `one black run, got ${JSON.stringify(meta.black)}`);
  assert.ok(Math.abs(meta.black[0][0] - 1) < 0.05 && Math.abs(meta.black[0][1] - 1.48) < 0.05, JSON.stringify(meta.black));
  const proxy = join(out, meta.proxy);
  const keys = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", proxy])
    .toString().trim().split("\n");
  assert.equal(keys.length, 20, "a keyframe every 5 frames over 100 frames");
  const before = statSync(join(out, "meta.json")).mtimeMs;
  await buildScrub(defaultTools, video, out, info);
  assert.equal(statSync(join(out, "meta.json")).mtimeMs, before, "second call reads the cache");
  const rebuilt = await buildScrub(defaultTools, video, out, { ...info, sha256: "f".repeat(64) });
  assert.equal(rebuilt.sha256, "f".repeat(64), "another version builds its own files");
});
