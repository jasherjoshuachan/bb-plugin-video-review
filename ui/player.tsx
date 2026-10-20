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

export type Tool = "none" | "box" | "arrow";

export interface PlayerHandle {
  seek(frame: number): void;
  step(delta: number): void;
  toggle(): void;
  play(rate?: number): void;
  pause(): void;
  isPlaying(): boolean;
  rate(): number;
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
  const loopRef = useRef({ loop, inPoint, outPoint });
  loopRef.current = { loop, inPoint, outPoint };
  const last = index.pts.length - 1;

  const seek = useCallback(
    (n: number) => {
      const video = videoRef.current;
      if (!video) return;
      const target = Math.max(0, Math.min(last, Math.round(n)));
      video.pause();
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
    }),
    [seek, frame],
  );

  // Follow every presented frame; loop the in/out range when asked.
  useEffect(() => {
    const video = videoEl;
    if (!video || typeof video.requestVideoFrameCallback !== "function") return;
    let handle = 0;
    const onPresented = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      const shown = frameAtTime(index, metadata.mediaTime);
      onFrame(shown);
      const { loop: looping, inPoint: a, outPoint: b } = loopRef.current;
      if (looping && a !== null && b !== null && !video.paused && shown >= b) {
        video.currentTime = seekTimeForFrame(index, a);
      }
      handle = video.requestVideoFrameCallback(onPresented);
    };
    handle = video.requestVideoFrameCallback(onPresented);
    const onSeeked = () => onFrame(frameAtTime(index, video.currentTime));
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

  const pct = (n: number) => `${(n / Math.max(1, last)) * 100}%`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
          onPlay={() => props.onPlayingChange(true)}
          onPause={() => props.onPlayingChange(false)}
          onError={props.onMediaError}
        />
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
      <div
        className="relative h-6 shrink-0 cursor-pointer border-t border-border bg-muted/40"
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={frame}
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          seek(((event.clientX - rect.left) / rect.width) * last);
        }}
      >
        {inPoint !== null ? (
          <div
            className="absolute inset-y-0 bg-primary/20"
            style={{ left: pct(inPoint), width: outPoint !== null && outPoint >= inPoint ? `calc(${pct(outPoint)} - ${pct(inPoint)})` : "2px" }}
          />
        ) : null}
        {props.notes
          .filter((note) => note.frameIn !== null)
          .map((note) => (
            <button
              key={note.id}
              type="button"
              title={`#${note.seq} ${note.text}`}
              aria-label={`Note ${note.seq}`}
              className={`absolute top-0.5 h-4 w-1.5 -translate-x-1/2 rounded-sm ${
                note.id === props.activeId ? "bg-primary" : "bg-foreground/60 hover:bg-foreground"
              }`}
              style={{ left: pct(note.frameIn!) }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => props.onSelectNote(note)}
            />
          ))}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500" style={{ left: pct(frame) }} />
      </div>
    </div>
  );
});
