import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cropFor } from "../lib/annotate.ts";
import { defaultTools } from "../lib/frames.ts";
import { VideoMedia } from "../lib/media.ts";

const dir = mkdtempSync(join(tmpdir(), "vr-media-"));
const video = join(dir, "clip.mp4");
execFileSync("ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", video,
]);

function size(png: string): string {
  return execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", png]).toString().trim();
}

test("a note's stills: raw, marked up, and a crop around the marks", async () => {
  const media = new VideoMedia(async () => defaultTools, join(dir, "stills"));
  const index = await media.index(video);
  const stills = await media.noteStills(
    "n_test01",
    video,
    index,
    20,
    [
      { type: "box", x: 400, y: 200, w: 120, h: 90 },
      { type: "arrow", x1: 100, y1: 100, x2: 380, y2: 210 },
    ],
    null,
  );
  assert.ok(existsSync(stills.raw));
  assert.ok(stills.annotated && existsSync(stills.annotated));
  assert.ok(stills.crop && existsSync(stills.crop));
  assert.equal(size(stills.raw), "640,360");
  assert.equal(size(stills.annotated!), "640,360");
  const area = cropFor(null, [
    { type: "box", x: 400, y: 200, w: 120, h: 90 },
    { type: "arrow", x1: 100, y1: 100, x2: 380, y2: 210 },
  ], 640, 360)!;
  assert.equal(size(stills.crop!), `${area.w},${area.h}`);
  assert.deepEqual(await media.existingStills("n_test01"), stills);
});

test("a frame of the file on disk now, cached by sha and frame", async () => {
  const media = new VideoMedia(async () => defaultTools, join(dir, "stills"));
  const first = await media.currentFrame(video, 10);
  const again = await media.currentFrame(video, 10);
  assert.equal(first.path, again.path);
  assert.equal(first.frame, 10);
  assert.equal((await media.currentFrame(video, 1e6)).frame, 49, "clamped to the last frame");
});
