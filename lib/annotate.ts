// Markup on a still, drawn by ffmpeg: boxes with drawbox, arrows as a run of
// small squares plus a two-stroke head. No image library needed, and the
// result is pixel exact at the video's own resolution.
import type { PixelRect, Shape } from "./types.ts";

const COLOR = "0xff3b30";
const THICKNESS = 4;
/** Arrow strokes are drawn as squares this far apart. */
const STEP = 3;
const MAX_SQUARES = 400;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function square(x: number, y: number, size: number): string {
  const half = Math.floor(size / 2);
  return `drawbox=x=${Math.round(x) - half}:y=${Math.round(y) - half}:w=${size}:h=${size}:color=${COLOR}:t=fill`;
}

function stroke(x1: number, y1: number, x2: number, y2: number, budget: { left: number }): string[] {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.min(budget.left, Math.ceil(length / STEP)));
  budget.left -= steps;
  const out: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push(square(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, THICKNESS));
  }
  return out;
}

/** ffmpeg filters that draw the shapes, clamped to the frame. */
export function shapeFilters(shapes: readonly Shape[], width: number, height: number): string[] {
  const filters: string[] = [];
  const budget = { left: MAX_SQUARES };
  for (const shape of shapes) {
    if (shape.type === "box") {
      const x = clamp(shape.x, 0, width - 1);
      const y = clamp(shape.y, 0, height - 1);
      const w = clamp(shape.w, 1, width - x);
      const h = clamp(shape.h, 1, height - y);
      filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${COLOR}:t=${THICKNESS}`);
      continue;
    }
    const { x1, y1, x2, y2 } = shape;
    filters.push(...stroke(x1, y1, x2, y2, budget));
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(14, Math.min(40, Math.hypot(x2 - x1, y2 - y1) / 4));
    for (const turn of [Math.PI * 0.82, -Math.PI * 0.82]) {
      filters.push(
        ...stroke(x2, y2, x2 + head * Math.cos(angle + turn), y2 + head * Math.sin(angle + turn), budget),
      );
    }
  }
  return filters;
}

/** The area a crop should cover: the note's rect, else the shapes' bounds, padded. */
export function cropFor(
  rect: PixelRect | null,
  shapes: readonly Shape[],
  width: number,
  height: number,
  pad = 24,
): PixelRect | null {
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    box = box
      ? { x0: Math.min(box.x0, x0), y0: Math.min(box.y0, y0), x1: Math.max(box.x1, x1), y1: Math.max(box.y1, y1) }
      : { x0, y0, x1, y1 };
  };
  if (rect) grow(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
  else {
    for (const shape of shapes) {
      if (shape.type === "box") grow(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h);
      else grow(Math.min(shape.x1, shape.x2), Math.min(shape.y1, shape.y2), Math.max(shape.x1, shape.x2), Math.max(shape.y1, shape.y2));
    }
  }
  if (!box) return null;
  const b = box as { x0: number; y0: number; x1: number; y1: number };
  const x = clamp(b.x0 - pad, 0, width - 1);
  const y = clamp(b.y0 - pad, 0, height - 1);
  const w = clamp(b.x1 + pad - x, 2, width - x);
  const h = clamp(b.y1 + pad - y, 2, height - y);
  // yuv420p crops want even sizes.
  return { x, y, w: w - (w % 2), h: h - (h % 2) };
}
