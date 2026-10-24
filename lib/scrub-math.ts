// The scrubber's pure math, shared by the server (lib/scrub.ts) and the tab: thumbnail tiles, the visible window of the
// timeline (zoom, pan, follow) and scene cuts. No Node imports, so the tab can bundle it.
export const COLS = 10;
export const ROWS = 10;
export const THUMB_W = 160;
/** Bumped when the files below change shape, so old caches are rebuilt. */
export const SCRUB_FORMAT = 1;

export interface ScrubMeta {
  format: number;
  sha256: string;
  /** Seconds between thumbnails. */
  step: number;
  /** Thumbnails in all sheets. */
  count: number;
  cols: number;
  rows: number;
  /** One tile, in pixels. */
  w: number;
  h: number;
  /** Sheet file names, in order. */
  sheets: string[];
  /** Black runs, [start, end] in seconds of the file. */
  black: [number, number][];
  proxy: string;
}

/** About 600 thumbnails across the film, never closer than 0.25 s. */
export function thumbStep(duration: number): number {
  return Math.max(0.25, Math.round((duration / 600) * 100) / 100);
}

/** Where the thumbnail for time `t` sits: its sheet and its top-left corner in that sheet. */
export function tileAt(meta: Pick<ScrubMeta, "step" | "count" | "cols" | "rows" | "w" | "h">, t: number) {
  const n = Math.max(0, Math.min(meta.count - 1, Math.floor(t / meta.step)));
  const perSheet = meta.cols * meta.rows;
  const sheet = Math.floor(n / perSheet);
  const k = n % perSheet;
  return { n, sheet, x: (k % meta.cols) * meta.w, y: Math.floor(k / meta.cols) * meta.h };
}

/** The black runs ffmpeg's blackdetect prints. */
export function parseBlack(stderr: string): [number, number][] {
  return [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
}

// ---------------------------------------------------------------- the visible window of the timeline, in frames

export interface View {
  /** First frame at the strip's left edge. */
  start: number;
  /** Frame at the strip's right edge (exclusive). */
  end: number;
}

/** The smallest window: about two seconds at 25 fps, so a zoomed strip still shows single frames. */
export const MIN_SPAN = 48;

export function fit(total: number): View {
  return { start: 0, end: Math.max(1, total) };
}

export function clampView(view: View, total: number): View {
  const span = Math.max(Math.min(MIN_SPAN, total), Math.min(total, view.end - view.start));
  let start = Math.max(0, Math.min(total - span, view.start));
  if (!Number.isFinite(start)) start = 0;
  return { start, end: start + span };
}

/** Zoom by `factor` (> 1 zooms in) keeping the frame under the cursor (`at`, 0-1 across the strip) where it is. */
export function zoom(view: View, factor: number, at: number, total: number): View {
  const span = view.end - view.start;
  const pivot = view.start + at * span;
  const next = span / factor;
  return clampView({ start: pivot - at * next, end: pivot - at * next + next }, total);
}

/** Pan by a share of the visible span (negative moves left). */
export function pan(view: View, share: number, total: number): View {
  const span = view.end - view.start;
  return clampView({ start: view.start + share * span, end: view.end + share * span }, total);
}

/** Keeps `frame` visible, sliding the window when it leaves it (for playback and frame steps while zoomed). */
export function follow(view: View, frame: number, total: number): View {
  if (frame >= view.start && frame < view.end) return view;
  const span = view.end - view.start;
  return clampView({ start: frame - span * 0.1, end: frame - span * 0.1 + span }, total);
}

export function frameAtX(view: View, x: number, width: number, last: number): number {
  const f = view.start + (Math.max(0, Math.min(width, x)) / Math.max(1, width)) * (view.end - view.start);
  return Math.max(0, Math.min(last, Math.floor(f)));
}

/** Share of the strip's width (0-1) where `frame` sits; may fall outside 0-1 when zoomed. */
export function shareAt(view: View, frame: number): number {
  return (frame - view.start) / Math.max(1, view.end - view.start);
}

/** Scene and section starts, sorted, without frame 0. */
export function cutsOf(spans: { start: number }[]): number[] {
  return [...new Set(spans.map((s) => s.start).filter((n) => n > 0))].sort((a, b) => a - b);
}

/** The next cut after `frame` (dir 1) or the last one before it (dir -1); null at either end. */
export function nextCut(cuts: number[], frame: number, dir: 1 | -1): number | null {
  if (dir > 0) return cuts.find((c) => c > frame) ?? null;
  for (let i = cuts.length - 1; i >= 0; i--) if (cuts[i] < frame) return cuts[i];
  return null;
}

