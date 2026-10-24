// The timeline under the picture, CapCut style (issue get-bb/bb#6039): the frame in the player is always the playhead's.
// Hovering moves the playhead with the cursor (skimming; S turns it off), click or drag moves it too, and it stays where you leave
// it. A time ruler with labels, a white playhead with a head, a thumbnail filmstrip, section and scene bands from the render
// manifest, note markers and black-frame marks. Cmd/Ctrl + scroll (or pinch) zooms around the cursor, plain or sideways scroll
// moves along, the slider and Fit set the zoom. Frame stepping, notes and markup stay the player's.
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { timecode } from "../lib/frame-math";
import type { FrameIndexDto } from "../lib/contract";
import type { Note } from "../lib/types";
import { clampView, fit, follow, frameAtX, MIN_SPAN, pan, shareAt, tileAt, zoom, type View } from "../lib/scrub-math";

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
  /** Skimming is on but held while a box or arrow is being drawn or a note is being written, so the picture stays under the marks. */
  skimPaused?: boolean;
  onToggleSkim: () => void;
  /** Moves the playhead (and the picture) to a frame. */
  onScrub: (frame: number) => void;
  notes: Note[];
  mappedMarks?: { note: Note; frame: number }[];
  activeId: string | null;
  onSelectNote: (note: Note) => void;
  inPoint: number | null;
  outPoint: number | null;
}

const RULER_H = 18;
const BANDS_H = 12;
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

/** Ruler label: mm:ss on whole seconds, frames ("10f") inside a second. */
function rulerLabel(frame: number, fps: number): string {
  const base = Math.max(1, Math.round(fps));
  const s = Math.floor(frame / base);
  const f = frame % base;
  return f === 0 ? `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${f}f`;
}

/** The slider's 0-100 against the visible span: 0 is the whole video, 100 the closest zoom. */
function sliderOf(span: number, total: number): number {
  const hi = Math.log(Math.max(total, MIN_SPAN + 1)), lo = Math.log(Math.min(MIN_SPAN, total));
  return hi === lo ? 0 : Math.round(((hi - Math.log(span)) / (hi - lo)) * 100);
}
function spanOf(value: number, total: number): number {
  const hi = Math.log(Math.max(total, MIN_SPAN + 1)), lo = Math.log(Math.min(MIN_SPAN, total));
  return Math.exp(hi - (value / 100) * (hi - lo));
}

export function Scrubber(props: Props) {
  const { index, frame, assets } = props;
  const total = index.pts.length;
  const last = total - 1;
  const fpsValue = index.fps.num / index.fps.den || 25;
  const [view, setView] = useState<View>(() => fit(total));
  const [width, setWidth] = useState(0);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const drag = useRef<{ mode: "scrub" | "pan"; x: number; start: View } | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  // One playhead move per screen frame, however fast the pointer reports.
  const queued = useRef<number | null>(null);
  const raf = useRef(0);
  const onScrubRef = useRef(props.onScrub);
  onScrubRef.current = props.onScrub;
  const scrub = (n: number) => {
    queued.current = n;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (queued.current !== null) onScrubRef.current(queued.current);
      queued.current = null;
    });
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  // Where the cursor last came to rest on the strip (or was clicked). Leaving the strip puts the playhead back there, so a quick
  // pass on the way to a button or the picture never moves it; resting 250 ms anywhere keeps that frame.
  const rest = useRef<number | null>(null);
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSkim = useRef<number | null>(null);
  const REST_MS = 250;
  const markRest = (n: number) => {
    if (restTimer.current) clearTimeout(restTimer.current);
    restTimer.current = setTimeout(() => {
      rest.current = n;
    }, REST_MS);
  };
  useEffect(() => () => {
    if (restTimer.current) clearTimeout(restTimer.current);
  }, []);

  useEffect(() => setView(fit(total)), [total, index.sha256]);
  // The window keeps the playhead on screen (playback, frame steps, cuts), as CapCut's timeline does.
  useEffect(() => setView((v) => follow(v, frame, total)), [frame, total]);

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    // Cmd/Ctrl + scroll and trackpad pinch (which arrives as ctrl + wheel) zoom around the cursor; plain or sideways scroll moves
    // along the timeline. Not passive, so the tab itself does not scroll.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const at = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      if (event.ctrlKey || event.metaKey) {
        const strength = event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 10 ? 0.03 : 0.006;
        setView((v) => zoom(v, Math.exp(-event.deltaY * strength), at, total));
      } else {
        const d = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        setView((v) => pan(v, d / Math.max(1, rect.width), total));
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

  // Ruler: labelled ticks about 90 px apart, small ticks between them.
  const ruler = useMemo(() => {
    const span = view.end - view.start;
    const steps = [1, 2, 5, 10, 25, 50, 125, 250, 500, 750, 1500, 3000, 7500].map((k) => Math.max(1, Math.round((k * fpsValue) / 25)));
    const major = steps.find((s) => (s / span) * width >= 90) ?? steps[steps.length - 1];
    const minor = Math.max(1, major / 5);
    const out: { f: number; major: boolean }[] = [];
    for (let f = Math.ceil(view.start / minor) * minor; f <= view.end; f += minor) {
      const r = Math.round(f);
      out.push({ f: r, major: r % major === 0 });
    }
    return out;
  }, [view, fpsValue, width]);

  const zoomed = view.start > 0 || view.end < total;
  const scene = assets ? spanAt(assets.scenes, frame) : null;
  const section = assets ? spanAt(assets.sections, frame) : null;
  const slider = sliderOf(view.end - view.start, total);
  // The ruler, bands, filmstrip and markers rebuild only when the zoom, the size or the data change, never per frame.
  const layers = useMemo(
    () => (
      <>
        {/* Ruler with time labels. */}
        <div className="absolute inset-x-0 top-0 overflow-hidden border-b border-white/10" style={{ height: RULER_H }}>
          {ruler.map(({ f, major }) => (
            <div key={f} className="absolute bottom-0" style={{ left: pct(f) }}>
              <div className={cn("w-px", major ? "h-2 bg-neutral-400" : "h-1 bg-neutral-600")} />
              {major ? (
                <span className="absolute bottom-2 left-1 whitespace-nowrap text-[10px] leading-none tabular-nums text-neutral-400">{rulerLabel(f, fpsValue)}</span>
              ) : null}
            </div>
          ))}
        </div>
        {/* Sections and scenes, from the render manifest. */}
        <div className="absolute inset-x-0 overflow-hidden" style={{ top: RULER_H, height: BANDS_H }}>
          {(assets?.sections ?? []).filter((s) => visible(s.start, s.end)).map((s, i) => (
            <div
              key={s.id}
              className={cn("absolute top-0 h-1/2 border-l border-white/20", i % 2 ? "bg-white/[0.10]" : "bg-white/[0.04]")}
              style={{ left: pct(s.start), width: `calc(${pct(s.end)} - ${pct(s.start)})` }}
              title={s.id}
            />
          ))}
          {(assets?.scenes ?? []).filter((s) => visible(s.start, s.end)).map((s, i) => (
            <div
              key={s.id}
              className={cn("absolute bottom-0 h-1/2 border-l border-black/50", i % 2 ? "bg-sky-500/45" : "bg-sky-500/25")}
              style={{ left: pct(s.start), width: `calc(${pct(s.end)} - ${pct(s.start)})` }}
              title={`${s.id}${s.kind ? ` (${s.kind})` : ""}`}
            />
          ))}
        </div>
        {/* Filmstrip with section labels, black frames marked red. */}
        <div className="absolute inset-x-0 overflow-hidden rounded-sm bg-black" style={{ top: RULER_H + BANDS_H + 2, height: STRIP_H }}>
          {assets
            ? slots.map((slot, i) => (
                <div key={i} className="absolute top-0 border-r border-black/70" style={{ left: slot.left, width: slot.width, height: STRIP_H, ...thumb(assets, slot.t, STRIP_H) }} />
              ))
            : null}
          {(assets?.sections ?? []).filter((s) => visible(s.start, s.end)).map((s) => (
            <span
              key={`l-${s.id}`}
              className="pointer-events-none absolute top-0 whitespace-nowrap rounded-br bg-black/60 px-1 text-[10px] leading-[14px] text-white"
              style={{ left: pct(Math.max(s.start, view.start)) }}
            >
              {s.id}
            </span>
          ))}
          {(assets?.black ?? []).filter(([a, b]) => visible(a, b)).map(([a, b]) => (
            <div
              key={`${a}-${b}`}
              className="absolute bottom-0 h-2 bg-red-500"
              style={{ left: pct(a), width: `max(2px, calc(${pct(b + 1)} - ${pct(a)}))` }}
              title={`Black frames ${a} to ${b}`}
            />
          ))}
        </div>
        {props.inPoint !== null ? (
          <div
            className="pointer-events-none absolute inset-y-0 bg-white/15"
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
              className={cn("absolute h-3 w-2 -translate-x-1/2 rounded-sm", note.id === props.activeId ? "bg-amber-400" : "bg-amber-300/80 hover:bg-amber-300")}
              style={{ left: pct(note.frameIn!), top: RULER_H - 4 }}
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
            className={cn("absolute h-3 w-2 -translate-x-1/2 rounded-sm border border-dashed", note.id === props.activeId ? "border-amber-400 bg-amber-400/40" : "border-amber-300/70 hover:bg-amber-300/40")}
            style={{ left: pct(at), top: RULER_H - 4 }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => props.onSelectNote(note)}
          />
        ))}
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, width, assets, slots, ruler, props.notes, props.mappedMarks, props.activeId, props.inPoint, props.outPoint, fpsValue],
  );

  return (
    <div className="shrink-0 select-none border-t border-border bg-[#141414] text-[11px] text-neutral-300">
      <div className="flex h-7 items-center gap-2 px-2">
        <span className="tabular-nums text-white">{timecode(index, frame)}</span>
        <span className="tabular-nums text-neutral-500">f{frame}</span>
        {section || scene ? (
          <span className="min-w-0 truncate text-neutral-400">
            {section?.id}
            {scene ? ` · ${scene.id}` : ""}
          </span>
        ) : null}
        <span className="flex-1" />
        {props.assetsError ? <span className="text-red-400">Timeline: {props.assetsError}</span> : null}
        {!assets && !props.assetsError ? <span className="text-neutral-500">Preparing the filmstrip…</span> : null}
        <button
          type="button"
          className={cn("rounded px-1.5 py-0.5", props.skimming ? "bg-white/15 text-white" : "text-neutral-400 hover:bg-white/10")}
          title="Skimming: the playhead follows the cursor over the timeline (S)"
          onClick={props.onToggleSkim}
        >
          {props.skimPaused ? "Skim paused (noting)" : `Skim ${props.skimming ? "on" : "off"}`}
        </button>
        <button type="button" className="rounded px-1.5 hover:bg-white/10" title="Zoom out" onClick={() => setView((v) => zoom(v, 1 / 1.6, shareAt(v, frame), total))}>
          −
        </button>
        <input
          type="range"
          min={0}
          max={100}
          value={slider}
          aria-label="Timeline zoom"
          className="h-1 w-24 accent-white"
          onChange={(event) => {
            const span = spanOf(Number(event.target.value), total);
            const at = Math.max(0, Math.min(1, shareAt(viewRef.current, frame)));
            setView(clampView({ start: frame - at * span, end: frame - at * span + span }, total));
          }}
        />
        <button type="button" className="rounded px-1.5 hover:bg-white/10" title="Zoom in (Cmd/Ctrl + scroll, or pinch, on the timeline)" onClick={() => setView((v) => zoom(v, 1.6, shareAt(v, frame), total))}>
          +
        </button>
        <button type="button" className={cn("rounded px-1.5 py-0.5", zoomed ? "hover:bg-white/10" : "opacity-40")} title="Fit the whole video" onClick={() => setView(fit(total))}>
          Fit
        </button>
      </div>
      <div
        ref={strip}
        className="relative cursor-pointer"
        style={{ height: RULER_H + BANDS_H + STRIP_H + 4 }}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={frame}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setHoverX(event.clientX - rect.left);
          const d = drag.current;
          if (d?.mode === "pan") {
            const share = (d.x - event.clientX) / Math.max(1, rect.width);
            const span = d.start.end - d.start.start;
            setView(clampView({ start: d.start.start + share * span, end: d.start.end + share * span }, total));
            return;
          }
          if (d?.mode === "scrub" || props.skimming) {
            const n = frameAt(event.clientX);
            if (rest.current === null) rest.current = frame;
            lastSkim.current = n;
            markRest(n);
            scrub(n);
          }
        }}
        onPointerLeave={() => {
          if (drag.current) return;
          setHoverX(null);
          if (restTimer.current) clearTimeout(restTimer.current);
          const back = rest.current;
          rest.current = null;
          if (props.skimming && back !== null && back !== lastSkim.current) scrub(back);
          lastSkim.current = null;
        }}
        onPointerDown={(event) => {
          if (event.button === 1 || (event.button === 0 && event.altKey)) {
            // middle button or Alt + drag pans the zoomed timeline
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { mode: "pan", x: event.clientX, start: viewRef.current };
            return;
          }
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { mode: "scrub", x: event.clientX, start: viewRef.current };
          const n = frameAt(event.clientX);
          rest.current = n;
          lastSkim.current = n;
          props.onScrub(n);
        }}
        onPointerUp={(event) => {
          const d = drag.current;
          drag.current = null;
          if (d?.mode === "scrub") {
            const n = frameAt(event.clientX);
            rest.current = n;               // a click or drag always keeps its frame
            lastSkim.current = n;
            if (restTimer.current) clearTimeout(restTimer.current);
            props.onScrub(n);
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {layers}
        {/* With skimming off, a faint line shows where a click would put the playhead. */}
        {!props.skimming && hoverX !== null ? <div className="pointer-events-none absolute inset-y-0 w-px bg-white/40" style={{ left: hoverX }} /> : null}
        {/* The playhead: a white line with a head on the ruler. */}
        <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: pct(frame) }}>
          <div className="absolute -left-[5px] top-0 h-3 w-[11px] bg-white" style={{ clipPath: "polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)" }} />
          <div className="absolute inset-y-0 -left-px w-0.5 bg-white" />
        </div>
      </div>
    </div>
  );
}
