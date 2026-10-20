// Content alignment between two renders of the same video.
//
// Every frame is reduced to a tiny grayscale signature (32x18 by default).
// A coarse dynamic-time-warping pass over every Nth frame finds the overall
// path (it handles inserted and removed stretches and speed changes, because
// it is not banded), then a banded pass at full frame rate refines it. The
// result maps each frame of the old render to the frame of the new render
// that shows the same picture, with a per-frame match distance, and lists
// the places where the timing shifts. Pure: no I/O, so it is unit tested
// on synthetic sequences.

export interface Signatures {
  /** Frame count. */
  count: number;
  /** Bytes per frame. */
  size: number;
  /** count * size grayscale bytes, frame after frame. */
  data: Uint8Array;
}

export interface Alignment {
  /** For each old frame, the matching new frame. */
  oldToNew: Int32Array;
  /** For each new frame, the matching old frame. */
  newToOld: Int32Array;
  /** Mean absolute gray difference (0-255) of each old frame to its match. */
  oldDistance: Float32Array;
  /** Same for each new frame. */
  newDistance: Float32Array;
  /** True for old frames that look the same as a neighbouring old frame (a still), so the exact frame within the hold is arbitrary. */
  oldHeld: Uint8Array;
  coarseStep: number;
  ms: number;
}

export interface AlignOptions {
  /** Upper bound on coarse sequence length; sets the coarse step. */
  coarseMax?: number;
  /** Extra cost for a non-diagonal step, in gray levels. Keeps held frames on the diagonal. */
  stepPenalty?: number;
}

/** Mean absolute difference between frame i of a and frame j of b. */
export function frameDistance(a: Signatures, i: number, b: Signatures, j: number): number {
  const size = a.size;
  const da = a.data;
  const db = b.data;
  let sum = 0;
  let pa = i * size;
  let pb = j * size;
  for (let k = 0; k < size; k++) {
    const d = da[pa++] - db[pb++];
    sum += d < 0 ? -d : d;
  }
  return sum / size;
}

/** Every `step`-th frame, each downscaled 2x2 when the width and height allow it. */
function coarse(sig: Signatures, step: number, width: number, height: number): { sig: Signatures; frames: number[] } {
  const frames: number[] = [];
  for (let i = 0; i < sig.count; i += step) frames.push(i);
  if (frames[frames.length - 1] !== sig.count - 1) frames.push(sig.count - 1);
  const halve = width % 2 === 0 && height % 2 === 0 && width * height === sig.size;
  const w = halve ? width / 2 : width;
  const h = halve ? height / 2 : height;
  const size = halve ? w * h : sig.size;
  const data = new Uint8Array(frames.length * size);
  frames.forEach((frame, n) => {
    const base = frame * sig.size;
    if (!halve) {
      data.set(sig.data.subarray(base, base + sig.size), n * size);
      return;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = base + 2 * y * width + 2 * x;
        data[n * size + y * w + x] =
          (sig.data[p] + sig.data[p + 1] + sig.data[p + width] + sig.data[p + width + 1] + 2) >> 2;
      }
    }
  });
  return { sig: { count: frames.length, size, data }, frames };
}

const DIAG = 0;
const UP = 1; // advance old only
const LEFT = 2; // advance new only

/**
 * Dynamic time warping restricted to j in [lo[i], hi[i]] for each i.
 * Returns the path as pairs, from (0, 0) to (n - 1, m - 1).
 */
function dtw(
  a: Signatures,
  b: Signatures,
  lo: Int32Array,
  hi: Int32Array,
  penalty: number,
): Array<[number, number]> {
  const n = a.count;
  const m = b.count;
  // Row-wise storage of each band; offsets[i] is where row i starts.
  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + (hi[i] - lo[i] + 1);
  const total = offsets[n];
  const cost = new Float64Array(total);
  const move = new Uint8Array(total);
  const at = (i: number, j: number): number => (j < lo[i] || j > hi[i] ? -1 : offsets[i] + (j - lo[i]));
  for (let i = 0; i < n; i++) {
    for (let j = lo[i]; j <= hi[i]; j++) {
      const here = offsets[i] + (j - lo[i]);
      const d = frameDistance(a, i, b, j);
      if (i === 0 && j === 0) {
        cost[here] = d;
        move[here] = DIAG;
        continue;
      }
      let best = Infinity;
      let how = DIAG;
      if (i > 0 && j > 0) {
        const p = at(i - 1, j - 1);
        if (p >= 0 && cost[p] < best) {
          best = cost[p];
          how = DIAG;
        }
      }
      if (i > 0) {
        const p = at(i - 1, j);
        if (p >= 0 && cost[p] + penalty < best) {
          best = cost[p] + penalty;
          how = UP;
        }
      }
      if (j > 0) {
        const p = here - 1;
        if (j - 1 >= lo[i] && cost[p] + penalty < best) {
          best = cost[p] + penalty;
          how = LEFT;
        }
      }
      cost[here] = best + d;
      move[here] = how;
    }
  }
  if (at(n - 1, m - 1) < 0 || !Number.isFinite(cost[at(n - 1, m - 1)])) throw new Error("No alignment path inside the band.");
  const path: Array<[number, number]> = [];
  let i = n - 1;
  let j = m - 1;
  for (;;) {
    path.push([i, j]);
    if (i === 0 && j === 0) break;
    const how = move[at(i, j)];
    if (how === DIAG) {
      i--;
      j--;
    } else if (how === UP) i--;
    else j--;
  }
  path.reverse();
  return path;
}

export function align(
  a: Signatures,
  b: Signatures,
  dims: { width: number; height: number },
  options: AlignOptions = {},
): Alignment {
  const started = Date.now();
  if (a.size !== b.size) throw new Error("Signatures differ in size.");
  if (a.count === 0 || b.count === 0) throw new Error("A video has no frames.");
  const penalty = options.stepPenalty ?? 0.5;
  const coarseMax = options.coarseMax ?? 1500;
  const step = Math.max(1, Math.ceil(Math.max(a.count, b.count) / coarseMax));

  // 1. Coarse, unbanded.
  const ca = coarse(a, step, dims.width, dims.height);
  const cb = coarse(b, step, dims.width, dims.height);
  const fullLo = new Int32Array(ca.sig.count);
  const fullHi = new Int32Array(ca.sig.count).fill(cb.sig.count - 1);
  const coarsePath = dtw(ca.sig, cb.sig, fullLo, fullHi, penalty);

  // 2. Band at full rate around the coarse path.
  const lo = new Int32Array(a.count).fill(b.count);
  const hi = new Int32Array(a.count).fill(-1);
  const widen = 2 * step + 4;
  for (let k = 0; k < coarsePath.length; k++) {
    const [ci, cj] = coarsePath[k];
    const [ni, nj] = coarsePath[Math.min(k + 1, coarsePath.length - 1)];
    const i0 = ca.frames[ci];
    const i1 = ca.frames[ni];
    const j0 = cb.frames[cj];
    const j1 = cb.frames[nj];
    for (let i = i0; i <= i1; i++) {
      const jMin = Math.min(j0, j1) - widen;
      const jMax = Math.max(j0, j1) + widen;
      if (jMin < lo[i]) lo[i] = jMin;
      if (jMax > hi[i]) hi[i] = jMax;
    }
  }
  for (let i = 0; i < a.count; i++) {
    lo[i] = Math.max(0, lo[i]);
    hi[i] = Math.min(b.count - 1, hi[i]);
    if (i > 0) {
      // Keep the band connected so a path always exists.
      if (lo[i] > hi[i - 1] + 1) lo[i] = hi[i - 1] + 1;
      if (hi[i] < lo[i - 1]) hi[i] = lo[i - 1];
    }
  }
  lo[0] = 0;
  hi[a.count - 1] = b.count - 1;
  const path = dtw(a, b, lo, hi, penalty);

  // 3. Per-frame matches: the closest partner each frame has on the path.
  const oldToNew = new Int32Array(a.count).fill(-1);
  const newToOld = new Int32Array(b.count).fill(-1);
  const oldDistance = new Float32Array(a.count).fill(Infinity);
  const newDistance = new Float32Array(b.count).fill(Infinity);
  for (const [i, j] of path) {
    const d = frameDistance(a, i, b, j);
    if (d < oldDistance[i]) {
      oldDistance[i] = d;
      oldToNew[i] = j;
    }
    if (d < newDistance[j]) {
      newDistance[j] = d;
      newToOld[j] = i;
    }
  }
  const oldHeld = new Uint8Array(a.count);
  for (let i = 0; i < a.count; i++) {
    const before = i > 0 ? frameDistance(a, i, a, i - 1) : Infinity;
    const after = i + 1 < a.count ? frameDistance(a, i, a, i + 1) : Infinity;
    if (Math.min(before, after) < 0.15) oldHeld[i] = 1;
  }
  return { oldToNew, newToOld, oldDistance, newDistance, oldHeld, coarseStep: step, ms: Date.now() - started };
}

/** How sure a single match is, from its distance in gray levels. */
export function matchConfidence(distance: number): "high" | "medium" | "low" | "none" {
  if (distance <= 2) return "high";
  if (distance <= 5) return "medium";
  if (distance <= 12) return "low";
  return "none";
}

export interface Shift {
  /** First old frame of the change. */
  oldFrame: number;
  /** The new frame it maps to. */
  newFrame: number;
  /** new - old before the change, in frames. */
  offsetBefore: number;
  /** new - old after the change, in frames. */
  offsetAfter: number;
  /** offsetAfter - offsetBefore: negative means the new render shows this moment earlier. */
  delta: number;
  /** Old frames the change took to settle (1 for a clean jump). */
  span: number;
}

export interface Change {
  /** changed: the picture differs clearly; slight: a small difference (a nudge, a colour); inserted: nothing in the old render looks like it. */
  kind: "changed" | "slight" | "inserted";
  /** New-render frames, inclusive. */
  from: number;
  to: number;
  /** The old frames they match, inclusive. */
  oldFrom: number;
  oldTo: number;
  /** Largest match distance in the run, in gray levels. */
  maxDistance: number;
}

export interface Removal {
  /** Old frames the new render no longer has, inclusive. */
  from: number;
  to: number;
  /** The new frame where they would have been. */
  at: number;
}

export interface AlignmentReport {
  shifts: Shift[];
  changes: Change[];
  removals: Removal[];
  /** Fraction of old frames matched with high or medium confidence. */
  matched: number;
}

export interface ReportOptions {
  /** Offset changes closer than this many frames merge into one shift. */
  settle?: number;
  /** Match distance above which a picture counts as changed. */
  changed?: number;
  /** Match distance above which a picture counts as slightly changed (above the encoder's noise). */
  slight?: number;
}

/**
 * Where the second render differs from the first: timing shifts (the same
 * pictures arrive earlier or later), pictures that changed, and stretches
 * that were cut. Offset changes that undo each other within `settle` frames
 * (one replaced frame) are not shifts; they show up as changes.
 */
export function alignmentReport(al: Alignment, options: ReportOptions = {}): AlignmentReport {
  const settle = options.settle ?? 8;
  const changedAt = options.changed ?? 1.0;
  const slightAt = options.slight ?? 0.4;
  const n = al.oldToNew.length;
  const m = al.newToOld.length;

  // Shifts: raw offset changes, merged when they follow each other closely.
  const raw: Array<{ i: number; before: number; after: number }> = [];
  let prev = al.oldToNew[0];
  for (let i = 1; i < n; i++) {
    const offset = al.oldToNew[i] - i;
    if (offset !== prev) raw.push({ i, before: prev, after: offset });
    prev = offset;
  }
  const shifts: Shift[] = [];
  for (let k = 0; k < raw.length; ) {
    let last = k;
    while (last + 1 < raw.length && raw[last + 1].i - raw[last].i < settle) last++;
    const before = raw[k].before;
    const after = raw[last].after;
    if (after !== before) {
      shifts.push({
        oldFrame: raw[k].i,
        newFrame: al.oldToNew[raw[k].i],
        offsetBefore: before,
        offsetAfter: after,
        delta: after - before,
        span: raw[last].i - raw[k].i + 1,
      });
    }
    k = last + 1;
  }

  // Changes: runs of new frames whose best old partner is not a close match.
  const changes: Change[] = [];
  let start = -1;
  for (let j = 0; j <= m; j++) {
    const d = j < m ? al.newDistance[j] : 0;
    if (d > slightAt && start < 0) start = j;
    if (d <= slightAt && start >= 0) {
      let max = 0;
      let oldFrom = Infinity;
      let oldTo = -1;
      for (let k = start; k < j; k++) {
        max = Math.max(max, al.newDistance[k]);
        oldFrom = Math.min(oldFrom, al.newToOld[k]);
        oldTo = Math.max(oldTo, al.newToOld[k]);
      }
      // New frames that all pile onto one or two old frames have no counterpart: they were added.
      const partners = new Set<number>();
      for (let k = start; k < j; k++) partners.add(al.newToOld[k]);
      const pileUp = j - start >= 3 && partners.size <= 2;
      const kind: Change["kind"] =
        matchConfidence(max) === "none" || pileUp ? "inserted" : max > changedAt ? "changed" : "slight";
      changes.push({ kind, from: start, to: j - 1, oldFrom, oldTo, maxDistance: Math.round(max * 100) / 100 });
      start = -1;
    }
  }

  // Removals: runs of old frames that pile onto one or two new frames and match them badly.
  const removals: Removal[] = [];
  start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const partners = new Set<number>();
    for (let k = start; k < end; k++) partners.add(al.oldToNew[k]);
    if (end - start >= 3 && partners.size <= 2) removals.push({ from: start, to: end - 1, at: al.oldToNew[start] });
    start = -1;
  };
  for (let i = 0; i <= n; i++) {
    const bad = i < n && al.oldDistance[i] > slightAt;
    if (bad && start < 0) start = i;
    if (!bad) flush(i);
  }

  let good = 0;
  for (let i = 0; i < n; i++) {
    const c = matchConfidence(al.oldDistance[i]);
    if (c === "high" || c === "medium") good++;
  }
  return { shifts, changes, removals, matched: good / n };
}

export interface FrameMapping {
  frame: number;
  confidence: "high" | "medium" | "low" | "none";
  held: boolean;
  /** Mapped frame minus the same index: how far the moment moved. */
  shifted: number;
}

export function mapOldFrame(al: Alignment, frame: number): FrameMapping {
  const i = Math.max(0, Math.min(al.oldToNew.length - 1, frame));
  const j = al.oldToNew[i];
  return { frame: j, confidence: matchConfidence(al.oldDistance[i]), held: al.oldHeld[i] === 1, shifted: j - i };
}

export function mapNewFrame(al: Alignment, frame: number): FrameMapping {
  const j = Math.max(0, Math.min(al.newToOld.length - 1, frame));
  const i = al.newToOld[j];
  return { frame: i, confidence: matchConfidence(al.newDistance[j]), held: false, shifted: i - j };
}
