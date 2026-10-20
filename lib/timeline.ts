// Render manifests: where each section and scene of a render starts and ends.
//
// A pipeline can say what it rendered: `{ fps, duration, sections: [{id, t0, t1}],
// scenes: [{id, kind?, t0, t1}] }` in seconds. With one manifest per version,
// a note maps across versions by "scene X, N frames in", which stays right
// when an earlier scene got longer or shorter. Pure functions only.

export interface Span {
  id: string;
  kind?: string;
  /** First frame, inclusive. */
  start: number;
  /** First frame after the span. */
  end: number;
}

export interface Timeline {
  fps: number;
  /** Total frames the manifest describes. */
  frames: number;
  sections: Span[];
  scenes: Span[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function spans(list: unknown, fps: number, label: string): Span[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`"${label}" must be a list.`);
  const out: Span[] = [];
  const seen = new Set<string>();
  for (const [n, item] of list.entries()) {
    if (!isRecord(item)) throw new Error(`${label}[${n}] must be an object.`);
    const { id, kind, t0, t1 } = item;
    if (typeof id !== "string" || id.length === 0) throw new Error(`${label}[${n}] needs an "id".`);
    if (typeof t0 !== "number" || typeof t1 !== "number" || !(t1 > t0) || t0 < 0) {
      throw new Error(`${label}[${n}] ("${id}") needs t0 < t1 in seconds.`);
    }
    if (seen.has(id)) throw new Error(`${label} has "${id}" twice.`);
    seen.add(id);
    out.push({
      id,
      ...(typeof kind === "string" ? { kind } : {}),
      start: Math.round(t0 * fps),
      end: Math.round(t1 * fps),
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Reads a manifest. `frames` is the video's real frame count: a manifest
 * whose duration is more than two frames off belongs to another render.
 */
export function parseTimeline(json: unknown, frames?: number): Timeline {
  if (!isRecord(json)) throw new Error("A timeline must be a JSON object.");
  const fps = json.fps;
  if (typeof fps !== "number" || !(fps > 0)) throw new Error('A timeline needs "fps".');
  const sections = spans(json.sections, fps, "sections");
  const scenes = spans(json.scenes, fps, "scenes");
  if (sections.length === 0 && scenes.length === 0) throw new Error('A timeline needs "sections" or "scenes".');
  const ends = [...sections, ...scenes].map((s) => s.end);
  const described = typeof json.duration === "number" ? Math.round(json.duration * fps) : Math.max(...ends);
  if (frames !== undefined && Math.abs(described - frames) > 2) {
    throw new Error(`This timeline describes ${described} frames but the video has ${frames}; it belongs to another render.`);
  }
  return { fps, frames: frames ?? described, sections, scenes };
}

function spanAt(list: Span[], frame: number): Span | null {
  for (const span of list) if (frame >= span.start && frame < span.end) return span;
  return null;
}

export interface ManifestMapping {
  frame: number;
  /** "scene" or "section": which list the id came from. */
  by: "scene" | "section";
  id: string;
  offset: number;
  /** exact: same length in both renders; resized: the span changed length, so the offset may land differently; clamped: the offset is past the new end. */
  fit: "exact" | "resized" | "clamped";
}

/** Maps a frame by the scene (else section) it falls in and its offset from that span's start. */
export function mapByTimeline(from: Timeline, to: Timeline, frame: number): ManifestMapping | null {
  for (const by of ["scene", "section"] as const) {
    const source = spanAt(by === "scene" ? from.scenes : from.sections, frame);
    if (!source) continue;
    const target = (by === "scene" ? to.scenes : to.sections).find((span) => span.id === source.id);
    if (!target) continue;
    const offset = frame - source.start;
    const last = target.end - 1;
    const mapped = target.start + offset;
    const sameLength = target.end - target.start === source.end - source.start;
    return {
      frame: Math.min(mapped, last),
      by,
      id: source.id,
      offset,
      fit: mapped > last ? "clamped" : sameLength ? "exact" : "resized",
    };
  }
  return null;
}

export interface BoundaryDelta {
  by: "scene" | "section";
  id: string;
  edge: "start" | "end";
  oldFrame: number;
  newFrame: number;
  delta: number;
}

/** Every section and scene edge that moved between two renders, in frames. */
export function boundaryDeltas(from: Timeline, to: Timeline): BoundaryDelta[] {
  const out: BoundaryDelta[] = [];
  for (const by of ["section", "scene"] as const) {
    const next = new Map((by === "scene" ? to.scenes : to.sections).map((span) => [span.id, span]));
    for (const span of by === "scene" ? from.scenes : from.sections) {
      const other = next.get(span.id);
      if (!other) continue;
      if (other.start !== span.start) {
        out.push({ by, id: span.id, edge: "start", oldFrame: span.start, newFrame: other.start, delta: other.start - span.start });
      }
      if (other.end !== span.end) {
        out.push({ by, id: span.id, edge: "end", oldFrame: span.end, newFrame: other.end, delta: other.end - span.end });
      }
    }
  }
  return out.sort((a, b) => a.oldFrame - b.oldFrame || (a.by === b.by ? 0 : a.by === "section" ? -1 : 1));
}

/** Ids present in one render but not the other. */
export function spanChanges(from: Timeline, to: Timeline): { added: string[]; removed: string[] } {
  const ids = (t: Timeline) => new Set([...t.sections, ...t.scenes].map((s) => s.id));
  const a = ids(from);
  const b = ids(to);
  return { added: [...b].filter((id) => !a.has(id)), removed: [...a].filter((id) => !b.has(id)) };
}
