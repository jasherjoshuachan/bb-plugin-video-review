// The scrubber strip under the picture (issue get-bb/bb#6039): hover to skim (the picture follows the cursor through a fast-seek
// proxy), click or drag to move the playhead, a thumbnail filmstrip, section and scene bands from the render manifest, note
// markers, black-frame marks, and zoom (scroll or pinch around the cursor) and pan (sideways scroll, or drag the bands).
// Frame stepping, notes and markup stay the player's; this only finds the moment faster.
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { timecode } from "../lib/frame-math";
import type { FrameIndexDto } from "../lib/contract";
import type { Note } from "../lib/types";
import { clampView, fit, follow, frameAtX, pan, shareAt, tileAt, zoom, type View } from "../lib/scrub-math";

export interface ScrubAssets {
  proxyUrl: string;
  sheetUrls: string[];
  step: number;
  count: number;
  cols: number;
  rows: number;
  w: number;
  h: number;
  black: [number, number][];
  sections: { id: string; start: number; end: number }[];
  scenes: { id: string; kind?: string; start: number; end: number }[];
}

interface Props {
  index: FrameIndexDto;
  frame: number;
  /** Null while the files are being built. */
  assets: ScrubAssets | null;
  assetsError: string | null;
  skimming: boolean;
  onToggleSkim: () => void;
  /** The frame under the cursor (null when the cursor leaves the strip); the player shows it. */
  onSkim: (frame: number | null) => void;
  onSeek: (frame: number) => void;
  notes: Note[];
  mappedMarks?: { note: Note; frame: number }[];
  activeId: string | null;
  onSelectNote: (note: Note) => void;
  inPoint: number | null;
  outPoint: number | null;
}

const STRIP_H = 48;

function spanAt<T extends { start: number; end: number }>(list: T[], frame: number): T | null {
  for (const s of list) if (frame >= s.start && frame < s.end) return s;
  return null;
}

/** Background style that shows the thumbnail for time `t`, scaled to `height` px. */
function thumb(assets: ScrubAssets, t: number, height: number): React.CSSProperties {
  const tile = tileAt(assets, t);
  const k = height / assets.h;
  const url = assets.sheetUrls[tile.sheet];
  if (!url) return {};
  return {
    backgroundImage: `url("${url}")`,
    backgroundSize: `${assets.cols * assets.w * k}px ${assets.rows * assets.h * k}px`,
    backgroundPosition: `-${tile.x * k}px -${tile.y * k}px`,
  };
}

export function Scrubber(props: Props) {
  const { index, frame, assets } = props;
  const total = index.pts.length;
  const last = total - 1;
  const fpsValue = index.fps.num / index.fps.den || 25;
  const [view, setView] = useState<View>(() => fit(total));
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ frame: number; x: number } | null>(null);
  const drag = useRef<{ mode: "seek" | "pan"; x: number; start: View; lastSeek: number } | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => setView(fit(total)), [total, index.sha256]);
  useEffect(() => setView((v) => follow(v, frame, total)), [frame, total]);

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    // Scroll or pinch zooms around the cursor; sideways scroll (or Shift + scroll) pans. Not passive, so the tab does not scroll.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const at = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const sideways = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (sideways) {
        const d = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX;
        setView((v) => pan(v, d / Math.max(1, rect.width), total));
      } else {
        const strength = event.ctrlKey ? 0.02 : 0.004;     // a trackpad pinch arrives as ctrl + wheel with small deltas
        setView((v) => zoom(v, Math.exp(-event.deltaY * strength), at, total));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [total]);

  const frameAt = (clientX: number) => {
    const el = strip.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return frameAtX(viewRef.current, clientX - rect.left, rect.width, last);
  };

  const pct = (n: number) => `${shareAt(view, n) * 100}%`;
  const visible = (a: number, b: number) => b >= view.start && a <= view.end;

  // Filmstrip slots: one thumbnail per slot, each showing the frame at the slot's middle.
  const slots = useMemo(() => {
    if (!assets || width <= 0) return [];
    const tileW = (STRIP_H * assets.w) / assets.h;
    const n = Math.max(1, Math.ceil(width / tileW));
    const out: { left: number; width: number; t: number }[] = [];
    for (let i = 0; i < n; i++) {
      const mid = frameAtX(view, (i + 0.5) * tileW, width, last);
      out.push({ left: i * tileW, width: tileW, t: (index.pts[mid] ?? 0) - index.formatStart });
    }
    return out;
  }, [assets, width, view, last, index.pts, index.formatStart]);

  // Ruler ticks at a readable interval for the zoom level.
  const ticks = useMemo(() => {
    const seconds = (view.end - view.start) / fpsValue;
    const every = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => seconds / s <= Math.max(4, width / 90)) ?? 300;
    const out: number[] = [];
    const first = Math.ceil(view.start / fpsValue / every) * every;
    for (let s = first; s * fpsValue <= view.end; s += every) out.push(Math.round(s * fpsValue));
    return out;
  }, [view, fpsValue, width]);

  const zoomed = view.start > 0 || view.end < total;
  const hoverScene = hover && assets ? spanAt(assets.scenes, hover.frame) : null;
  const hoverSection = hover && assets ? spanAt(assets.sections, hover.frame) : null;

  return (
    <div className="shrink-0 select-none border-t border-border bg-muted/30 text-[11px]">
      <div className="flex h-6 items-center gap-2 px-2 text-muted-foreground">
        <span className="tabular-nums">
          {hover ? `${timecode(index, hover.frame)} · f${hover.frame}` : `${timecode(index, frame)} · f${frame}`}
        </span>
        {hover && (hoverSection || hoverScene) ? (
          <span className="min-w-0 truncate">
            {hoverSection?.id}
            {hoverScene ? ` · ${hoverScene.id}` : ""}
          </span>
        ) : null}
        <span className="flex-1" />
        {props.assetsError ? <span className="text-destructive">Scrubber: {props.assetsError}</span> : null}
        {!assets && !props.assetsError ? <span>Preparing the filmstrip…</span> : null}
        <button
          type="button"
          className={cn("rounded px-1.5 py-0.5", props.skimming ? "bg-primary/15 text-foreground" : "hover:bg-muted")}
          title="Skim: the picture follows the cursor over the timeline (S)"
          onClick={props.onToggleSkim}
        >
          Skim {props.skimming ? "on" : "off"}
        </button>
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" title="Zoom out" onClick={() => setView((v) => zoom(v, 1 / 1.6, 0.5, total))}>
          −
        </button>
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" title="Zoom in (or scroll / pinch on the strip)" onClick={() => setView((v) => zoom(v, 1.6, shareAt(v, frame), total))}>
          +
        </button>
        <button
          type="button"
          className={cn("rounded px-1.5 py-0.5", zoomed ? "hover:bg-muted" : "opacity-40")}
          title="Fit the whole video"
          onClick={() => setView(fit(total))}
        >
          Fit
        </button>
      </div>
      <div
        ref={strip}
        className="relative cursor-pointer"
        style={{ height: 14 + 10 + STRIP_H }}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={frame}
        onPointerMove={(event) => {
          const f = frameAt(event.clientX);
          const rect = event.currentTarget.getBoundingClientRect();
          setHover({ frame: f, x: event.clientX - rect.left });
          const d = drag.current;
          if (d?.mode === "pan") {
            const share = (d.x - event.clientX) / Math.max(1, rect.width);
            setView(clampView({ start: d.start.start + share * (d.start.end - d.start.start), end: d.start.end + share * (d.start.end - d.start.start) }, total));
            return;
          }
          if (d?.mode === "seek") {
            props.onSkim(f);
            const now = performance.now();
            if (now - d.lastSeek > 120) {
              d.lastSeek = now;
              props.onSeek(f);
            }
            return;
          }
          if (props.skimming) props.onSkim(f);
        }}
        onPointerLeave={() => {
          if (drag.current) return;
          setHover(null);
          props.onSkim(null);
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = event.currentTarget.getBoundingClientRect();
          const onBands = event.clientY - rect.top < 24;
          if (onBands && zoomed) {
            drag.current = { mode: "pan", x: event.clientX, start: viewRef.current, lastSeek: 0 };
            return;
          }
          const f = frameAt(event.clientX);
          drag.current = { mode: "seek", x: event.clientX, start: viewRef.current, lastSeek: performance.now() };
          props.onSeek(f);
          props.onSkim(f);
        }}
        onPointerUp={(event) => {
          const d = drag.current;
          drag.current = null;
          if (d?.mode === "seek") props.onSeek(frameAt(event.clientX));
          props.onSkim(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          props.onSkim(null);
        }}
      >
        {/* Sections, then scenes, from the render manifest. */}
        <div className="absolute inset-x-0 top-0 h-3.5 overflow-hidden">
          {(assets?.sections ?? []).filter((s) => visible(s.start, s.end)).map((s, i) => (
            <div
              key={s.id}
              className={cn("absolute inset-y-0 border-l border-border", i % 2 ? "bg-foreground/[0.07]" : "bg-foreground/[0.03]")}
              style={{ left: pct(s.start), width: `calc(${pct(s.end)} - ${pct(s.start)})` }}
              title={s.id}
            />
          ))}
          {(assets?.sections ?? []).filter((s) => visible(s.start, s.end)).map((s) => (
            // the label rides at the strip's left edge while its section starts off screen (zoomed in)
            <span
              key={`l-${s.id}`}
              className="pointer-events-none absolute top-0 whitespace-nowrap px-1 leading-[14px] text-[10px]"
              style={{ left: pct(Math.max(s.start, view.start)), maxWidth: `calc(${pct(s.end)} - ${pct(Math.max(s.start, view.start))})`, overflow: "hidden" }}
            >
              {s.id}
            </span>
          ))}
        </div>
        <div className="absolute inset-x-0 top-3.5 h-2.5 overflow-hidden">
          {(assets?.scenes ?? []).filter((s) => visible(s.start, s.end)).map((s, i) => (
            <div
              key={s.id}
              className={cn("absolute inset-y-0 border-l border-foreground/30", i % 2 ? "bg-primary/25" : "bg-primary/10")}
              style={{ left: pct(s.start), width: `calc(${pct(s.end)} - ${pct(s.start)})` }}
              title={`${s.id}${s.kind ? ` (${s.kind})` : ""}`}
            />
          ))}
          {ticks.map((t) => (
            <div key={t} className="absolute top-0 h-full w-px bg-foreground/25" style={{ left: pct(t) }} />
          ))}
        </div>
        {/* Filmstrip. */}
        <div className="absolute inset-x-0 bottom-0 overflow-hidden bg-black/80" style={{ height: STRIP_H }}>
          {assets
            ? slots.map((slot, i) => (
                <div key={i} className="absolute top-0 border-r border-black/60" style={{ left: slot.left, width: slot.width, height: STRIP_H, ...thumb(assets, slot.t, STRIP_H) }} />
              ))
            : null}
          {(assets?.black ?? []).filter(([a, b]) => visible(a, b)).map(([a, b]) => (
            <div
              key={`${a}-${b}`}
              className="absolute bottom-0 h-2 bg-red-500"
              style={{ left: pct(a), width: `max(2px, calc(${pct(b + 1)} - ${pct(a)}))` }}
              title={`Black frames ${a} to ${b}`}
            />
          ))}
        </div>
        {/* In and out, notes, hover and playhead. */}
        {props.inPoint !== null ? (
          <div
            className="pointer-events-none absolute inset-y-0 bg-primary/20"
            style={{
              left: pct(props.inPoint),
              width: props.outPoint !== null && props.outPoint >= props.inPoint ? `calc(${pct(props.outPoint)} - ${pct(props.inPoint)})` : "2px",
            }}
          />
        ) : null}
        {props.notes
          .filter((note) => note.frameIn !== null && visible(note.frameIn, note.frameIn))
          .map((note) => (
            <button
              key={note.id}
              type="button"
              title={`#${note.seq} ${note.text}`}
              aria-label={`Note ${note.seq}`}
              className={cn(
                "absolute top-0 h-6 w-1.5 -translate-x-1/2 rounded-sm",
                note.id === props.activeId ? "bg-primary" : "bg-foreground/70 hover:bg-foreground",
              )}
              style={{ left: pct(note.frameIn!) }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => props.onSelectNote(note)}
            />
          ))}
        {(props.mappedMarks ?? []).filter(({ frame: at }) => visible(at, at)).map(({ note, frame: at }) => (
          <button
            key={`m-${note.id}`}
            type="button"
            title={`#${note.seq} from ${note.versionLabel}: ${note.text}`}
            aria-label={`Note ${note.seq} from ${note.versionLabel}`}
            className={cn(
              "absolute top-1 h-4 w-1.5 -translate-x-1/2 rounded-sm border border-dashed",
              note.id === props.activeId ? "border-primary bg-primary/40" : "border-foreground/60 bg-transparent hover:bg-foreground/40",
            )}
            style={{ left: pct(at) }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => props.onSelectNote(note)}
          />
        ))}
        {hover ? <div className="pointer-events-none absolute inset-y-0 w-px bg-foreground/70" style={{ left: hover.x }} /> : null}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500" style={{ left: pct(frame) }} />
        {/* Hover preview: the frame under the cursor with its timecode. */}
        {hover && assets ? (
          <div
            className="pointer-events-none absolute bottom-[52px] z-10 -translate-x-1/2 rounded border border-border bg-popover p-1 shadow-md"
            style={{ left: Math.max(70, Math.min(width - 70, hover.x)) }}
          >
            <div style={{ width: (72 * assets.w) / assets.h, height: 72, ...thumb(assets, (index.pts[hover.frame] ?? 0) - index.formatStart, 72) }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
