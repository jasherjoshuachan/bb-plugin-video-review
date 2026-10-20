// The file-opener tab: player, transport, notes, and the hand-off to this
// chat or a new one (the send flow follows Doc Review's review-opener, MIT,
// (c) 2026 Foma; see NOTICE).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useBbContext, useBbNavigate, type PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { frameLabel, timecode } from "../lib/frame-math";
import type { Note, NoteKind, Shape } from "../lib/types";
import { errorText, useDiskSha, useNotes, useReviewRpc, useVideo, type Loaded } from "./hooks";
import { NoteEditor, NotesList, type EditorValue, type NoteActions } from "./notes-panel";
import { Player, type PlayerHandle, type Tool } from "./player";

/** Below this tab width the notes go under the player. */
const WIDE_MIN_PX = 760;

const KEYS: [string, string][] = [
  ["Space / K", "Play or pause"],
  ["← / →", "One frame back or forward"],
  ["Shift + ← / →", "Ten frames"],
  ["J", "Back one second"],
  ["L", "Play; press again for 1.5x, 2x"],
  ["I / O", "Set in and out"],
  ["Shift + I / O", "Go to in or out"],
  ["X", "Clear in and out"],
  ["Ctrl + L", "Loop in to out"],
  ["M or ;", "Note on this frame (or the in–out range)"],
  ["B / A", "Draw a box / an arrow"],
  [", / .", "Previous / next note"],
  ["F", "Go to frame number"],
  ["Esc", "Stop drawing, close"],
  ["?", "This help"],
];

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

interface Pending {
  /** Editing an existing note, or a new one bound to this frame/range. */
  note: Note | null;
  frameIn: number;
  frameOut: number;
  kinds: NoteKind[];
  initial: EditorValue;
}

export function VideoReviewOpener({ path, source }: PluginFileOpenerProps) {
  const { loaded, error, reload, refreshMedia } = useVideo(path, source);
  if (error) {
    return (
      <Centered>
        <p className="text-foreground">Could not open this video.</p>
        <p className="max-w-md text-xs">{error}</p>
      </Centered>
    );
  }
  if (!loaded) {
    return (
      <Centered>
        <Icon name="Loading" className="size-5 animate-spin" />
        <p>Reading frames…</p>
      </Centered>
    );
  }
  return <Review loaded={loaded} reload={reload} refreshMedia={refreshMedia} source={source} />;
}

function Review({
  loaded,
  reload,
  refreshMedia,
  source,
}: {
  loaded: Loaded;
  reload: () => Promise<void>;
  refreshMedia: () => Promise<void>;
  source: PluginFileOpenerProps["source"];
}) {
  const { video, version, index, media } = loaded;
  const rpc = useReviewRpc();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const threadId = context.threadId ?? source.threadId ?? null;
  const { notes: fetched, stillBase, error: notesError, refetch } = useNotes(video.id);
  const notes = fetched ?? [];
  const disk = useDiskSha(video.id);
  const player = useRef<PlayerHandle | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [inPoint, setIn] = useState<number | null>(null);
  const [outPoint, setOut] = useState<number | null>(null);
  const [loop, setLoop] = useState(false);
  const [tool, setTool] = useState<Tool>("none");
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [goTo, setGoTo] = useState<string | null>(null);
  const [wide, setWide] = useState(true);

  const last = index.pts.length - 1;
  const drafts = notes.filter((note) => note.status === "draft");
  const needsYou = notes.filter((note) => note.status === "fixed" || note.status === "question").length;
  const changedOnDisk = disk?.sha256 && disk.sha256 !== index.sha256 ? disk.versions.find((v) => v.sha256 === disk.sha256) ?? null : null;
  const active = notes.find((note) => note.id === activeId) ?? null;

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWide(element.clientWidth >= WIDE_MIN_PX));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    root.current?.focus();
  }, []);

  const onFrame = useCallback((n: number) => setFrame(n), []);

  const openEditor = useCallback(() => {
    player.current?.pause();
    const hasRange = inPoint !== null && outPoint !== null && outPoint > inPoint;
    const inRange = hasRange && frame >= inPoint! && frame <= outPoint!;
    // The frame is bound now, when the note starts, not when it is saved.
    setPending({
      note: null,
      frameIn: inRange ? inPoint! : frame,
      frameOut: inRange ? outPoint! : frame,
      kinds: inRange ? ["range", "frame", "general"] : ["frame", "general"],
      initial: { kind: inRange ? "range" : "frame", text: "", category: "other" },
    });
  }, [frame, inPoint, outPoint]);

  const selectNote = useCallback(
    (note: Note) => {
      setActiveId(note.id);
      if (note.frameIn !== null && note.mediaSha256 === index.sha256) player.current?.seek(note.frameIn);
      else if (note.frameIn !== null) toast.message(`This note was written on ${note.versionLabel}; its frame may not match this file.`);
    },
    [index.sha256],
  );

  const jumpNote = useCallback(
    (direction: 1 | -1) => {
      const framed = notes.filter((note) => note.frameIn !== null).sort((a, b) => a.frameIn! - b.frameIn!);
      const next = direction > 0 ? framed.find((note) => note.frameIn! > frame) : [...framed].reverse().find((note) => note.frameIn! < frame);
      if (next) selectNote(next);
    },
    [notes, frame, selectNote],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]")) return;
    const key = event.key;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (key === " " || key === "k" || key === "K") {
      handled();
      player.current?.toggle();
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      handled();
      player.current?.step((key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1));
    } else if (key === "j" || key === "J") {
      handled();
      player.current?.seek(frame - Math.round(index.fps.num / index.fps.den));
    } else if ((key === "l" || key === "L") && (event.ctrlKey || event.metaKey)) {
      handled();
      setLoop((value) => !value);
    } else if (key === "l" || key === "L") {
      handled();
      const handle = player.current;
      if (!handle) return;
      const rate = handle.isPlaying() ? (handle.rate() >= 2 ? 1 : handle.rate() + 0.5) : 1;
      handle.play(rate);
    } else if (key === "i" || key === "I") {
      handled();
      if (event.shiftKey) {
        if (inPoint !== null) player.current?.seek(inPoint);
      } else {
        setIn(frame);
        if (outPoint !== null && outPoint < frame) setOut(null);
      }
    } else if (key === "o" || key === "O") {
      handled();
      if (event.shiftKey) {
        if (outPoint !== null) player.current?.seek(outPoint);
      } else {
        setOut(frame);
        if (inPoint !== null && inPoint > frame) setIn(null);
      }
    } else if (key === "x" || key === "X") {
      handled();
      setIn(null);
      setOut(null);
      setLoop(false);
    } else if (key === "m" || key === "M" || key === ";") {
      handled();
      openEditor();
    } else if (key === "b" || key === "B") {
      handled();
      player.current?.pause();
      setTool((value) => (value === "box" ? "none" : "box"));
    } else if (key === "a" || key === "A") {
      handled();
      player.current?.pause();
      setTool((value) => (value === "arrow" ? "none" : "arrow"));
    } else if (key === ",") {
      handled();
      jumpNote(-1);
    } else if (key === ".") {
      handled();
      jumpNote(1);
    } else if (key === "f" || key === "F") {
      handled();
      setGoTo(String(frame));
    } else if (key === "?") {
      handled();
      setHelp((value) => !value);
    } else if (key === "Escape") {
      handled();
      if (tool !== "none") setTool("none");
      else if (help) setHelp(false);
      else setPending(null);
    }
  };

  const save = async (value: EditorValue) => {
    if (!pending) return;
    setSaving(true);
    try {
      if (pending.note) {
        await rpc.call("notes.update", { id: pending.note.id, text: value.text, category: value.category });
      } else {
        const general = value.kind === "general";
        const created = await rpc.call("notes.create", {
          videoId: video.id,
          sha256: index.sha256,
          kind: value.kind,
          frameIn: general ? null : pending.frameIn,
          frameOut: general ? null : value.kind === "range" ? pending.frameOut : pending.frameIn,
          text: value.text,
          category: value.category,
          shapes: general ? [] : shapes,
        });
        setActiveId(created.id);
        setShapes([]);
        setTool("none");
      }
      setPending(null);
      refetch();
      root.current?.focus();
    } catch (cause) {
      toast.error(`Could not save the note: ${errorText(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  const run = (promise: Promise<unknown>) => promise.then(refetch, (cause: unknown) => toast.error(errorText(cause)));
  const actions: NoteActions = {
    onSelect: selectNote,
    onEdit(note) {
      setPending({
        note,
        frameIn: note.frameIn ?? 0,
        frameOut: note.frameOut ?? 0,
        kinds: [note.kind],
        initial: { kind: note.kind, text: note.text, category: note.category },
      });
    },
    onDelete: (note) => run(rpc.call("notes.delete", { id: note.id })),
    onReopen: (note) => run(rpc.call("notes.reopen", { id: note.id })),
    onVerify: (note) => run(rpc.call("notes.verify", { id: note.id })),
    onWontfix: (note) => run(rpc.call("notes.wontfix", { id: note.id })),
  };

  const send = async (target: "thread" | "new") => {
    if (drafts.length === 0 || sending) return;
    setSending(true);
    const count = drafts.length;
    const noun = count === 1 ? "note" : "notes";
    try {
      if (target === "thread") {
        if (!threadId) throw new Error("Open this video from a chat to send notes there.");
        await rpc.call("notes.send", { videoId: video.id, target: { kind: "thread", threadId } });
        toast.success(`Sent ${count} ${noun} to this chat`);
      } else {
        try {
          const result = await rpc.call("notes.send", {
            videoId: video.id,
            target: {
              kind: "new-thread",
              sourceThreadId: threadId,
              projectId: source.projectId,
              environmentId: source.kind === "workspace" ? source.environmentId : null,
            },
          });
          toast.success(`Started a new chat with ${count} ${noun}`, {
            action: { label: "Open", onClick: () => navigate.toThread(result.threadId) },
          });
        } catch (cause) {
          if (!/not in a project/i.test(errorText(cause))) throw cause;
          // No project to start a chat in: prefill the new-chat screen instead.
          const handoff = await rpc.call("notes.handoffPrompt", { videoId: video.id });
          await rpc.call("notes.markSent", { ids: handoff.ids, threadId: null });
          navigate.toCompose({ initialPrompt: handoff.prompt, focusPrompt: true });
        }
      }
      refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSending(false);
    }
  };

  const pendingLabel = useMemo(() => {
    if (!pending) return "";
    if (pending.note) return pending.note.frameLabel ?? `${pending.note.versionLabel} whole video`;
    const start = frameLabel(index, pending.frameIn, version.label);
    return pending.frameOut > pending.frameIn ? `${start} → ${timecode(index, pending.frameOut)} (${pending.frameOut})` : start;
  }, [pending, index, version.label]);

  const fps = index.fps.num / index.fps.den;
  const notesPanel = (
    <div className={cn("min-h-0 overflow-auto bg-background", wide ? "w-80 shrink-0 border-l border-border" : "h-[45%] border-t border-border")}>
      {pending ? (
        <NoteEditor
          key={pending.note?.id ?? `${pending.frameIn}-${pending.frameOut}`}
          label={pendingLabel}
          kinds={pending.kinds}
          initial={pending.initial}
          shapeCount={pending.note ? pending.note.shapes.length : shapes.length}
          busy={saving}
          onClearShapes={() => setShapes([])}
          onCancel={() => {
            setPending(null);
            root.current?.focus();
          }}
          onSubmit={(value) => void save(value)}
        />
      ) : null}
      <NotesList
        notes={notes}
        activeId={activeId}
        currentSha={index.sha256}
        stillBase={stillBase}
        actions={actions}
        header={notesError ? <p className="text-xs text-destructive">{notesError}</p> : null}
      />
    </div>
  );

  return (
    <div
      ref={root}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative flex h-full min-h-0 flex-col bg-background outline-none"
      aria-label={`Video review: ${video.name}`}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{version.label}</span>
        <span className="font-mono text-muted-foreground" title={index.sha256}>
          {index.sha256.slice(0, 12)}
        </span>
        <span className="text-muted-foreground">
          {index.width}×{index.height} · {Number.isInteger(fps) ? fps : fps.toFixed(3)} fps{index.vfr ? " · variable rate" : ""}
        </span>
        <div className="flex-1" />
        {needsYou > 0 ? <span className="text-primary">{needsYou} need you</span> : null}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          aria-label="Keyboard shortcuts"
          onClick={() => setHelp((value) => !value)}
        >
          <Icon name="Keyboard" className="size-4" />
        </Button>
        <Button size="sm" variant="outline" className="h-7" disabled={drafts.length === 0 || sending || !threadId} onClick={() => void send("thread")}>
          Send {drafts.length || ""} to this chat
        </Button>
        <Button size="sm" variant="ghost" className="h-7" disabled={drafts.length === 0 || sending} onClick={() => void send("new")}>
          New chat
        </Button>
      </div>

      {changedOnDisk || (disk?.sha256 && disk.sha256 !== index.sha256) ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs">
          <span className="flex-1">
            The file on disk changed{changedOnDisk ? ` (now ${changedOnDisk.label})` : ""}. You are looking at {version.label}; notes stay on the version they were written on.
          </span>
          <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={() => void reload().catch((cause) => toast.error(errorText(cause)))}>
            Load {changedOnDisk?.label ?? "it"}
          </Button>
        </div>
      ) : null}

      <div className={cn("flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Player
            ref={player}
            url={media.url}
            index={index}
            notes={notes.filter((note) => note.mediaSha256 === index.sha256)}
            activeId={activeId}
            frame={frame}
            onFrame={onFrame}
            inPoint={inPoint}
            outPoint={outPoint}
            loop={loop}
            tool={tool}
            shapes={shapes}
            shownShapes={active && active.mediaSha256 === index.sha256 && active.frameIn === frame ? active.shapes : []}
            onShape={(shape) => {
              setShapes((current) => [...current, shape]);
              if (!pending) openEditor();
            }}
            onMediaError={() => void refreshMedia().catch(() => toast.error("The video could not be loaded."))}
            onSelectNote={selectNote}
            onPlayingChange={setPlaying}
          />
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-1.5 text-xs">
            <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="One frame back" onClick={() => player.current?.step(-1)}>
              <Icon name="ChevronLeft" className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={playing ? "Pause" : "Play"} onClick={() => player.current?.toggle()}>
              <Icon name={playing ? "Pause" : "Play"} className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="One frame forward" onClick={() => player.current?.step(1)}>
              <Icon name="ChevronRight" className="size-4" />
            </Button>
            <span className="font-mono tabular-nums">
              {timecode(index, frame)} · frame {frame} / {last}
            </span>
            {goTo !== null ? (
              <input
                autoFocus
                aria-label="Go to frame"
                className="h-6 w-20 rounded border border-input bg-transparent px-1 font-mono"
                value={goTo}
                onChange={(event) => setGoTo(event.target.value.replace(/[^0-9]/g, ""))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    player.current?.seek(Number(goTo || 0));
                    setGoTo(null);
                    root.current?.focus();
                  } else if (event.key === "Escape") {
                    setGoTo(null);
                    root.current?.focus();
                  }
                  event.stopPropagation();
                }}
                onBlur={() => setGoTo(null)}
              />
            ) : null}
            <span className="text-muted-foreground">
              {inPoint !== null ? `in ${inPoint}` : ""}
              {outPoint !== null ? ` · out ${outPoint}` : ""}
              {loop ? " · looping" : ""}
            </span>
            <div className="flex-1" />
            <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Mark the picture">
              {(["box", "arrow"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={tool === value}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-[5px] px-2",
                    tool === value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => {
                    player.current?.pause();
                    setTool((current) => (current === value ? "none" : value));
                  }}
                >
                  <Icon name={value === "box" ? "Square" : "ArrowUpRight"} className="size-3.5" />
                  {value === "box" ? "Box" : "Arrow"}
                </button>
              ))}
            </div>
            <Button size="sm" variant="secondary" className="h-7" onClick={openEditor}>
              <Icon name="MessageSquare" className="size-4" /> Note (M)
            </Button>
          </div>
        </div>
        {notesPanel}
      </div>

      {help ? (
        <div className="absolute right-3 top-12 z-10 w-72 rounded-md border border-border bg-popover p-3 text-xs shadow-lg">
          <div className="mb-2 flex items-center">
            <span className="flex-1 font-medium">Keys</span>
            <button type="button" aria-label="Close" onClick={() => setHelp(false)}>
              <Icon name="X" className="size-3.5" />
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {KEYS.map(([keys, what]) => (
              <div key={keys} className="contents">
                <dt className="font-mono text-muted-foreground">{keys}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
