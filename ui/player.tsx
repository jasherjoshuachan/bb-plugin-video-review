// The frame-aware player. The shown frame comes from requestVideoFrameCallback's
// mediaTime mapped through the file's own presentation timestamps (never
// currentTime * fps); seeks aim just inside a frame. Markup is drawn on an SVG
// laid exactly over the picture, in the video's own pixels.
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { frameAtTime, seekTimeForFrame } from "../lib/frame-math";
import type { FrameIndexDto } from "../lib/contract";
import type { Note, Shape } from "../lib/types";
import { Scrubber, type ScrubAssets } from "./scrubber";

export type Tool = "none" | "box" | "arrow";

export type CompareMode = "ab" | "side" | "wipe" | "diff";

/** A second version shown with the first, kept on the matching frame. */
export interface CompareView {
  url: string;
  index: FrameIndexDto;
  label: string;
  mainLabel: string;
  mode: CompareMode;
  /** A/B mode: show the other version instead of this one. */
  showOther: boolean;
  /** Wipe position, 0-1 across the picture (the other version is right of it). */
  wipe: number;
  /** Difference mode: strength of the other layer, 0-1. */
  opacity: number;
  /** The other version's frame that matches the shown frame. */
  target: number;
  onWipe: (value: number) => void;
  onMediaError: () => void;
}

export interface PlayerHandle {
  seek(frame: number): void;
  step(delta: number): void;
  toggle(): void;
  play(rate?: number): void;
  pause(): void;
  isPlaying(): boolean;
  rate(): number;
  /** The frame under the cursor on the scrubber, or null. */
  skimFrame(): number | null;
}

interface Props {
  url: string;
  index: FrameIndexDto;
  /** Notes to mark on the timeline. */
  notes: Note[];
  activeId: string | null;
  frame: number;
  onFrame: (frame: number) => void;
  inPoint: number | null;
  outPoint: number | null;
  loop: boolean;
  tool: Tool;
  shapes: Shape[];
  /** Markup of the selected note, shown read-only. */
  shownShapes: Shape[];
  onShape: (shape: Shape) => void;
  onMediaError: () => void;
  onSelectNote: (note: Note) => void;
  onPlayingChange: (playing: boolean) => void;
  /** Notes from other versions, marked at the frame they map to here (dimmed). */
  mappedMarks?: { note: Note; frame: number }[];
  compare?: CompareView | null;
  /** The scrubber's files (null while they are built) and its state. */
  scrub: ScrubAssets | null;
  scrubError: string | null;
  skimming: boolean;
  onToggleSkim: () => void;
}

/** The other version, kept on the frame that matches the main player. */
function CompareVideo({
  view,
  box,
  playing,
  rate,
  className,
}: {
  view: CompareView;
  box: { left: number; top: number; width: number; height: number };
  playing: boolean;
  rate: number;
  className: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const shown = useRef(-1);
  const { index, target } = view;

  // Track which frame the other video shows.
  useEffect(() => {
    const video = ref.current;
    if (!video || typeof video.requestVideoFrameCallback !== "function") return;
    let handle = 0;
    const onPresented = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      shown.current = frameAtTime(index, metadata.mediaTime);
      handle = video.requestVideoFrameCallback(onPresented);
    };
    handle = video.requestVideoFrameCallback(onPresented);
    return () => video.cancelVideoFrameCallback(handle);
  }, [index, view.url]);

  // Paused: sit exactly on the matching frame. Playing: follow, and resync when it drifts.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (!playing) {
      video.pause();
      if (shown.current !== target) video.currentTime = seekTimeForFrame(index, target);
      return;
    }
    video.playbackRate = rate;
    if (video.paused) {
      video.currentTime = seekTimeForFrame(index, target);
      void video.play().catch(() => undefined);
    } else if (Math.abs(shown.current - target) > 2) {
      video.currentTime = seekTimeForFrame(index, target);
    }
  }, [target, playing, rate, index]);

  const style: React.CSSProperties = {};
  if (view.mode === "ab") style.visibility = view.showOther ? "visible" : "hidden";
  if (view.mode === "wipe") style.clipPath = `inset(0 0 0 ${box.left + view.wipe * box.width}px)`;
  if (view.mode === "diff") {
    style.mixBlendMode = "difference";
    style.opacity = view.opacity;
  }
  return (
    <video
      ref={ref}
      src={view.url}
      preload="auto"
      muted
      playsInline
      className={className}
      style={style}
      onLoadedMetadata={(event) => {
        event.currentTarget.currentTime = seekTimeForFrame(index, target);
      }}
      onError={view.onMediaError}
    />
  );
}

function useContentBox(video: HTMLVideoElement | null, width: number, height: number) {
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  useEffect(() => {
    if (!video) return;
    const update = () => {
      const w = video.clientWidth;
      const h = video.clientHeight;
      const scale = Math.min(w / width, h / height);
      const bw = width * scale;
      const bh = height * scale;
      setBox({ left: video.offsetLeft + (w - bw) / 2, top: video.offsetTop + (h - bh) / 2, width: bw, height: bh });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(video);
    return () => observer.disconnect();
  }, [video, width, height]);
  return box;
}

function ShapeMarks({ shapes, muted }: { shapes: Shape[]; muted?: boolean }) {
  const stroke = muted ? "rgba(255,59,48,0.65)" : "#ff3b30";
  return (
    <>
      {shapes.map((shape, i) =>
        shape.type === "box" ? (
          <rect key={i} x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill="none" stroke={stroke} strokeWidth={4} vectorEffect="non-scaling-stroke" />
        ) : (
          <line
            key={i}
            x1={shape.x1}
            y1={shape.y1}
            x2={shape.x2}
            y2={shape.y2}
            stroke={stroke}
            strokeWidth={4}
            vectorEffect="non-scaling-stroke"
            markerEnd="url(#vr-arrow)"
          />
        ),
      )}
    </>
  );
}

export const Player = forwardRef<PlayerHandle, Props>(function Player(props, ref) {
  const { url, index, frame, onFrame, inPoint, outPoint, loop, tool } = props;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const box = useContentBox(videoEl, index.width, index.height);
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rateNow, setRateNow] = useState(1);
  const compare = props.compare ?? null;
  const side = compare?.mode === "side";
  const loopRef = useRef({ loop, inPoint, outPoint });
  loopRef.current = { loop, inPoint, outPoint };
  const last = index.pts.length - 1;
  const [skim, setSkim] = useState<number | null>(null);
  const skimRef = useRef<number | null>(null);
  skimRef.current = skim;
  const proxyRef = useRef<HTMLVideoElement | null>(null);

  // Scrubbing moves the playhead (CapCut): the playhead and the frame counter go to the cursor at once, the fast-seek proxy shows
  // that frame while the cursor moves, and the full render seeks there once the cursor rests; the proxy steps aside when the full
  // render shows the same frame. One proxy seek at a time: the newest target waits and goes next, so a fast sweep never queues.
  const pendingRef = useRef<number | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skimTime = (n: number) => (index.pts[n] ?? 0) - index.formatStart + 0.5 / Math.max(1, index.fps.num / index.fps.den || 25);
  const applySkim = useCallback(() => {
    const proxy = proxyRef.current;
    const n = skimRef.current;
    if (!proxy || n === null || proxy.readyState < 1 || proxy.seeking) return;
    const t = skimTime(n);
    if (Math.abs(proxy.currentTime - t) > 0.001) proxy.currentTime = t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);
  useEffect(() => applySkim(), [skim, applySkim]);

  const scrubTo = useCallback(
    (n: number) => {
      const video = videoRef.current;
      if (!video) return;
      const target = Math.max(0, Math.min(last, Math.round(n)));
      video.pause();
      pendingRef.current = target;
      if (props.scrub) setSkim(target);
      onFrame(target);
      if (settle.current) clearTimeout(settle.current);
      settle.current = setTimeout(() => {
        if (pendingRef.current !== target) return;
        if (!video.seeking && frameAtTime(index, video.currentTime) === target) {
          pendingRef.current = null;          // already there: no seek will report back
          setSkim(null);
          return;
        }
        video.currentTime = seekTimeForFrame(index, target);
        // a seek that never reports (a stalled load) must not freeze the playhead
        setTimeout(() => {
          if (pendingRef.current === target) {
            pendingRef.current = null;
            setSkim(null);
          }
        }, 3000);
      }, props.scrub ? 140 : 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, last, onFrame, props.scrub],
  );
  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current);
  }, []);

  const seek = useCallback(
    (n: number) => {
      const video = videoRef.current;
      if (!video) return;
      const target = Math.max(0, Math.min(last, Math.round(n)));
      video.pause();
      pendingRef.current = target;
      setSkim(null);
      video.currentTime = seekTimeForFrame(index, target);
      onFrame(target);
    },
    [index, last, onFrame],
  );

  useImperativeHandle(
    ref,
    () => ({
      seek,
      step(delta) {
        seek(frame + delta);
      },
      toggle() {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
      },
      play(rate = 1) {
        const video = videoRef.current;
        if (!video) return;
        video.playbackRate = rate;
        void video.play().catch(() => undefined);
      },
      pause() {
        videoRef.current?.pause();
      },
      isPlaying() {
        const video = videoRef.current;
        return Boolean(video && !video.paused);
      },
      rate() {
        return videoRef.current?.playbackRate ?? 1;
      },
      skimFrame() {
        return skimRef.current;
      },
    }),
    [seek, frame],
  );

  // Follow every presented frame; loop the in/out range when asked.
  useEffect(() => {
    const video = videoEl;
    if (!video || typeof video.requestVideoFrameCallback !== "function") return;
    let handle = 0;
    // While a scrub or seek is on its way, the old frame must not pull the playhead back; the target arriving clears the proxy.
    const arrive = (shown: number): boolean => {
      const want = pendingRef.current;
      if (want === null) return true;
      if (shown !== want) return false;
      pendingRef.current = null;
      setSkim(null);
      return true;
    };
    const onPresented = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      const shown = frameAtTime(index, metadata.mediaTime);
      if (!video.paused) {
        pendingRef.current = null;
        setSkim(null);
      }
      if (arrive(shown)) onFrame(shown);
      const { loop: looping, inPoint: a, outPoint: b } = loopRef.current;
      if (looping && a !== null && b !== null && !video.paused && shown >= b) {
        video.currentTime = seekTimeForFrame(index, a);
      }
      handle = video.requestVideoFrameCallback(onPresented);
    };
    handle = video.requestVideoFrameCallback(onPresented);
    const onSeeked = () => {
      const shown = frameAtTime(index, video.currentTime);
      if (arrive(shown)) onFrame(shown);
    };
    video.addEventListener("seeked", onSeeked);
    return () => {
      video.cancelVideoFrameCallback(handle);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [videoEl, index, onFrame]);

  // Keep the position when the URL is re-minted or the file is reloaded.
  const resumeFrame = useRef<number | null>(null);
  useEffect(() => {
    resumeFrame.current = frame;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, index]);

  const toSource = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * index.width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * index.height);
    return { x: Math.max(0, Math.min(index.width, x)), y: Math.max(0, Math.min(index.height, y)) };
  };

  const finishDrag = () => {
    if (!drag) return;
    const { x, y, x2, y2 } = drag;
    setDrag(null);
    if (tool === "box") {
      const w = Math.abs(x2 - x);
      const h = Math.abs(y2 - y);
      if (w >= 4 && h >= 4) props.onShape({ type: "box", x: Math.min(x, x2), y: Math.min(y, y2), w, h });
    } else if (tool === "arrow" && Math.hypot(x2 - x, y2 - y) >= 8) {
      props.onShape({ type: "arrow", x1: x, y1: y, x2, y2 });
    }
  };

  const pending: Shape[] =
    drag && tool === "box"
      ? [{ type: "box", x: Math.min(drag.x, drag.x2), y: Math.min(drag.y, drag.y2), w: Math.abs(drag.x2 - drag.x), h: Math.abs(drag.y2 - drag.y) }]
      : drag && tool === "arrow"
        ? [{ type: "arrow", x1: drag.x, y1: drag.y, x2: drag.x2, y2: drag.y2 }]
        : [];


  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
      <div className="relative min-h-0 flex-1 bg-black">
        <video
          ref={(element) => {
            videoRef.current = element;
            setVideoEl(element);
          }}
          src={url}
          preload="auto"
          playsInline
          className="absolute inset-0 h-full w-full object-contain"
          onLoadedMetadata={(event) => {
            const target = resumeFrame.current;
            if (target !== null && target > 0) event.currentTarget.currentTime = seekTimeForFrame(index, target);
          }}
          onPlay={() => {
            setIsPlaying(true);
            props.onPlayingChange(true);
          }}
          onPause={() => {
            setIsPlaying(false);
            props.onPlayingChange(false);
          }}
          onRateChange={(event) => setRateNow(event.currentTarget.playbackRate)}
          onError={props.onMediaError}
        />
        {props.scrub ? (
          <video
            ref={proxyRef}
            src={props.scrub.proxyUrl}
            preload="auto"
            muted
            playsInline
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            style={{ visibility: skim !== null ? "visible" : "hidden" }}
            onLoadedMetadata={applySkim}
            onSeeked={applySkim}
          />
        ) : null}

        {compare && !side ? (
          <CompareVideo
            view={compare}
            box={box}
            playing={isPlaying}
            rate={rateNow}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        ) : null}
        {compare ? (
          <div className="pointer-events-none absolute left-2 top-2 flex gap-1 text-[11px]">
            <span className={`rounded px-1.5 py-0.5 ${compare.mode === "ab" && compare.showOther ? "bg-black/50 text-white/60" : "bg-black/70 text-white"}`}>
              A {compare.mainLabel}
            </span>
            {compare.mode !== "side" ? (
              <span className={`rounded px-1.5 py-0.5 ${compare.mode !== "ab" || compare.showOther ? "bg-primary text-primary-foreground" : "bg-black/50 text-white/60"}`}>
                B {compare.label} · frame {compare.target}
              </span>
            ) : null}
          </div>
        ) : null}
        {compare?.mode === "wipe" ? (
          <div
            className="absolute z-10 w-3 -translate-x-1/2 cursor-ew-resize"
            style={{ left: box.left + compare.wipe * box.width, top: box.top, height: box.height }}
            role="slider"
            aria-label="Wipe position"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(compare.wipe * 100)}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const parent = event.currentTarget.parentElement?.getBoundingClientRect();
              if (!parent || box.width <= 0) return;
              compare.onWipe(Math.max(0, Math.min(1, (event.clientX - parent.left - box.left) / box.width)));
            }}
          >
            <div className="mx-auto h-full w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]" />
          </div>
        ) : null}
        <svg
          viewBox={`0 0 ${index.width} ${index.height}`}
          preserveAspectRatio="none"
          className="absolute"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            cursor: tool === "none" ? "default" : "crosshair",
            pointerEvents: tool === "none" ? "none" : "auto",
          }}
          onPointerDown={(event) => {
            if (tool === "none") return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const p = toSource(event);
            setDrag({ x: p.x, y: p.y, x2: p.x, y2: p.y });
          }}
          onPointerMove={(event) => {
            if (!drag) return;
            const p = toSource(event);
            setDrag({ ...drag, x2: p.x, y2: p.y });
          }}
          onPointerUp={finishDrag}
          onPointerCancel={() => setDrag(null)}
        >
          <defs>
            <marker id="vr-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff3b30" />
            </marker>
          </defs>
          <ShapeMarks shapes={props.shownShapes} muted />
          <ShapeMarks shapes={[...props.shapes, ...pending]} />
        </svg>
      </div>
      {compare && side ? (
        <div className="relative min-h-0 flex-1 border-l border-border bg-black">
          <CompareVideo
            view={compare}
            box={box}
            playing={isPlaying}
            rate={rateNow}
            className="absolute inset-0 h-full w-full object-contain"
          />
          <span className="pointer-events-none absolute left-2 top-2 rounded bg-primary px-1.5 py-0.5 text-[11px] text-primary-foreground">
            B {compare.label} · frame {compare.target}
          </span>
        </div>
      ) : null}
      </div>
      <Scrubber
        index={index}
        frame={frame}
        assets={props.scrub}
        assetsError={props.scrubError}
        skimming={props.skimming}
        onToggleSkim={props.onToggleSkim}
        onScrub={scrubTo}
        notes={props.notes}
        mappedMarks={props.mappedMarks}
        activeId={props.activeId}
        onSelectNote={props.onSelectNote}
        inPoint={inPoint}
        outPoint={outPoint}
      />
    </div>
  );
});
