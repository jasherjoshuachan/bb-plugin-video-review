// Pure frame math shared by the server and the player (no Node imports).
//
// A note's position is a 0-based frame index into one exact file (its sha256).
// Seconds and timecode are derived for display only. The browser reports the
// presented frame's time (requestVideoFrameCallback mediaTime) on the file's
// own timeline, so we map it through the file's real presentation timestamps
// instead of multiplying by fps; that keeps start offsets and variable frame
// rate files right.

export interface Rational {
  num: number;
  den: number;
}

export interface FrameIndex {
  sha256: string;
  width: number;
  height: number;
  /** Nominal rate from the stream (r_frame_rate), exact rational. */
  fps: Rational;
  /** True when frame spacing varies by more than a tenth of a frame. */
  vfr: boolean;
  /** Container start_time in seconds; ffmpeg input seeks count from here. */
  formatStart: number;
  /** Presentation time of each frame in display order, seconds, file timeline. */
  pts: number[];
}

/** Frame shown at file time t: the last frame whose pts is at or before t. */
export function frameAtTime(index: FrameIndex, t: number): number {
  const { pts } = index;
  const eps = 1e-4;
  if (t < pts[0] - eps) return 0;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid] <= t + eps) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Time to assign to video.currentTime to show frame n. Browsers show the frame
 * at or before the seek time, and a seek exactly on a boundary can land on the
 * previous frame, so nudge a little into the frame (Kitsu does the same).
 */
export function seekTimeForFrame(index: FrameIndex, n: number): number {
  const { pts } = index;
  const i = clampFrame(index, n);
  const next = i + 1 < pts.length ? pts[i + 1] : pts[i] + frameDuration(index);
  return pts[i] + Math.min(0.001, (next - pts[i]) / 4);
}

export function clampFrame(index: FrameIndex, n: number): number {
  return Math.max(0, Math.min(index.pts.length - 1, Math.trunc(n)));
}

export function frameDuration(index: FrameIndex): number {
  return index.fps.num > 0 ? index.fps.den / index.fps.num : 1 / 30;
}

/** Non-drop timecode HH:MM:SS:FF on the nominal rate, from the frame index. */
export function timecode(index: FrameIndex, n: number): string {
  const base = Math.max(1, Math.round(index.fps.num / index.fps.den || 30));
  const f = clampFrame(index, n);
  const ff = f % base;
  const totalSeconds = Math.floor(f / base);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(ff)}`;
}

/** Version-stamped label, Kitsu style: `v7 00:01:12:17 (2177)`. */
export function frameLabel(index: FrameIndex, n: number, version?: string): string {
  const tc = `${timecode(index, n)} (${clampFrame(index, n)})`;
  return version ? `${version} ${tc}` : tc;
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}
