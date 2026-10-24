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
import type { FrameIndexDto, MediaDto, ReportDto } from "../lib/contract";
import type { Note, NoteKind, Shape, VideoVersion } from "../lib/types";
import { CompareBar, ReportPanel, viewable, type CompareState } from "./compare";
import {
  errorText,
  useDiskSha,
  useFrameMaps,
  useMappings,
  useNotes,
  useOpenIntent,
  useReviewRpc,
  useVideo,
  type Loaded,
} from "./hooks";
import { NoteEditor, NotesList, type EditorValue, type NoteActions } from "./notes-panel";
import { Player, type CompareView, type PlayerHandle, type Tool } from "./player";
import { Scrubber, type ScrubAssets } from "./scrubber";
import { cutsOf, nextCut } from "../lib/scrub-math";

/** Below this tab width the notes go under the player. */
const WIDE_MIN_PX = 760;

const KEYS: [string, string][] = [
  ["Space / K", "Play or pause"],
  ["← / →", "One frame back or forward"],
  ["Shift + ← / →", "One second back or forward"],
  ["↑ / ↓", "Previous / next scene cut (from the render manifest)"],
  ["Hover the timeline", "Skim: the playhead follows the cursor; it keeps the frame where the cursor rested (a quick pass does not move it)"],
  ["S", "Skimming on or off (off: only a click or drag moves the playhead)"],
  ["Cmd/Ctrl + scroll, or pinch", "Zoom the timeline around the cursor"],
  ["Scroll on the timeline", "Move along it when zoomed in (Alt + drag too)"],
  ["J", "Back one second"],
  ["L", "Play; press again for 1.5x, 2x"],
  ["I / O", "Set in and out"],
  ["Shift + I / O", "Go to in or out"],
  ["X", "Clear in and out"],
  ["Ctrl + L", "Loop in to out"],
  ["M or ;", "Note on this frame (the playhead's)"],
  ["B / A", "Draw a box / an arrow"],
  [", / .", "Previous / next note"],
  ["F", "Go to frame number"],
  ["C", "Compare with the previous version"],
  ["\\", "A/B: flip between the two"],
  ["V / R / N", "Verify mode: verify, reopen, next"],
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
  const { loaded, error, reload, refreshMedia, loadVersion } = useVideo(path, source);
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
  return <Review loaded={loaded} reload={reload} refreshMedia={refreshMedia} loadVersion={loadVersion} source={source} />;
}

/** Older first, by when each version was first seen. */
function byAge(versions: VideoVersion[]): VideoVersion[] {
  return [...versions].sort((a, b) => a.firstSeenAt - b.firstSeenAt);
}

function findVersionRef(versions: VideoVersion[], ref: string): VideoVersion | null {
  const wanted = ref.trim().toLowerCase();
  return versions.find((v) => v.label === wanted) ?? (wanted.length >= 8 ? versions.find((v) => v.sha256.startsWith(wanted)) ?? null : null);
}

function Review({
  loaded,
  reload,
  refreshMedia,
  loadVersion,
  source,
}: {
  loaded: Loaded;
  reload: () => Promise<void>;
  refreshMedia: () => Promise<void>;
  loadVersion: (sha256: string) => Promise<void>;
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

  const [frame, setFrame] = useState(loaded.intent?.frame ?? 0);
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
  const [compare, setCompare] = useState<CompareState | null>(null);
  const [other, setOther] = useState<{ version: VideoVersion; index: FrameIndexDto; media: MediaDto } | null>(null);
  const [report, setReport] = useState<{ open: boolean; data: ReportDto | null; error: string | null }>({ open: false, data: null, error: null });
  const [verifying, setVerifying] = useState(false);
  const [skimming, setSkimming] = useState(true);
  const [scrub, setScrub] = useState<ScrubAssets | null>(null);
  const [scrubError, setScrubError] = useState<string | null>(null);
  const pendingIntent = useRef<string | null>(loaded.intent?.compare ?? null);

  const versions = useMemo(() => byAge(disk?.versions ?? [version]), [disk?.versions, version]);
  const diskSha = disk?.sha256 ?? null;
  const onDiskFile = diskSha === null || diskSha === index.sha256;
  const notesKey = notes.map((n) => `${n.id}:${n.status}:${n.updatedAt}`).join(",");
  const mappings = useMappings(video.id, index.sha256, notesKey);
  const { maps, error: mapError } = useFrameMaps(video.id, compare ? index.sha256 : null, compare?.sha ?? null);
  const target = compare && maps ? maps.forward[Math.min(frame, maps.forward.length - 1)] ?? null : null;
  const fixedQueue = useMemo(
    () => notes.filter((note) => note.status === "fixed" && note.frameIn !== null).sort((a, b) => a.seq - b.seq),
    [notes],
  );

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

  // The scrubber's files for the version on screen (built once per version on the server, about a minute for a long render).
  useEffect(() => {
    let alive = true;
    setScrub(null);
    setScrubError(null);
    rpc.call("scrub.assets", { videoId: video.id, sha256: index.sha256 }).then(
      (assets) => alive && setScrub(assets),
      (cause: unknown) => alive && setScrubError(errorText(cause)),
    );
    return () => {
      alive = false;
    };
  }, [rpc, video.id, index.sha256]);

  const onFrame = useCallback((n: number) => setFrame(n), []);

  const openEditor = useCallback((at?: number) => {
    player.current?.pause();
    if (!onDiskFile) {
      const now = versions.find((v) => v.sha256 === diskSha);
      toast.message(`Notes go on the file on disk now${now ? ` (${now.label})` : ""}. Switch to it to add notes.`);
      return;
    }
    const here = at ?? frame;
    const hasRange = inPoint !== null && outPoint !== null && outPoint > inPoint;
    const inRange = hasRange && here >= inPoint! && here <= outPoint!;
    // The frame is bound now, when the note starts, not when it is saved.
    setPending({
      note: null,
      frameIn: inRange ? inPoint! : here,
      frameOut: inRange ? outPoint! : here,
      kinds: inRange ? ["range", "frame", "general"] : ["frame", "general"],
      initial: { kind: inRange ? "range" : "frame", text: "", category: "other" },
    });
  }, [frame, inPoint, outPoint, onDiskFile, versions, diskSha]);

  /** Where a note sits on the version being viewed: its own frame, or where it maps to. */
  const frameHere = useCallback(
    (note: Note): number | null => {
      if (note.frameIn === null) return null;
      if (note.mediaSha256 === index.sha256) return note.frameIn;
      const mapping = mappings.get(note.id);
      return mapping && !mapping.unmappable ? mapping.frameIn : null;
    },
    [index.sha256, mappings],
  );

  const notesHere = useMemo(() => notes.filter((note) => note.mediaSha256 === index.sha256), [notes, index.sha256]);
  const marksHere = useMemo(
    () =>
      notes
        .filter((note) => note.mediaSha256 !== index.sha256 && note.status !== "verified" && note.status !== "wontfix")
        .map((note) => ({ note, frame: frameHere(note) }))
        .filter((item): item is { note: Note; frame: number } => item.frame !== null),
    [notes, index.sha256, frameHere],
  );

  const selectNote = useCallback(
    (note: Note) => {
      setActiveId(note.id);
      if (note.frameIn === null) return;
      const here = frameHere(note);
      if (here === null) {
        toast.message(`This note was written on ${note.versionLabel} and has no reliable match on ${version.label}.`);
        return;
      }
      player.current?.seek(here);
      const mapping = note.mediaSha256 === index.sha256 ? null : mappings.get(note.id);
      if (mapping && mapping.confidence !== "high") {
        toast.message(`From ${note.versionLabel}: mapped to frame ${here} by ${mapping.method}, ${mapping.confidence} confidence.`);
      }
    },
    [frameHere, index.sha256, mappings, version.label],
  );

  const jumpNote = useCallback(
    (direction: 1 | -1) => {
      const framed = notes
        .map((note) => ({ note, at: frameHere(note) }))
        .filter((item): item is { note: Note; at: number } => item.at !== null)
        .sort((a, b) => a.at - b.at);
      const next = direction > 0 ? framed.find((item) => item.at > frame) : [...framed].reverse().find((item) => item.at < frame);
      if (next) selectNote(next.note);
    },
    [notes, frame, selectNote, frameHere],
  );

  /** Show another version in this tab, staying on the matching moment. */
  const switchVersion = useCallback(
    async (sha256: string) => {
      if (sha256 === index.sha256) return;
      player.current?.pause();
      try {
        const m = await rpc.call("versions.maps", { videoId: video.id, fromSha: index.sha256, toSha: sha256 }).catch(() => null);
        setFrame(m ? m.forward[Math.min(frame, m.forward.length - 1)] ?? frame : frame);
        setCompare((current) => (current && current.sha === sha256 ? { ...current, sha: index.sha256 } : current));
        await loadVersion(sha256);
      } catch (cause) {
        toast.error(errorText(cause));
      }
    },
    [rpc, video.id, index.sha256, frame, loadVersion],
  );

  const previousVersion = useCallback((): VideoVersion | null => {
    const at = versions.findIndex((v) => v.sha256 === index.sha256);
    const candidates = [...versions.slice(0, Math.max(0, at)).reverse(), ...versions.slice(at + 1)];
    return candidates.find((v) => viewable(v, diskSha)) ?? null;
  }, [versions, index.sha256, diskSha]);

  const startCompare = useCallback(
    (sha256?: string) => {
      const otherVersion = sha256 ? versions.find((v) => v.sha256 === sha256) ?? null : previousVersion();
      if (!otherVersion) {
        toast.message("There is no other version of this video to compare with yet.");
        return;
      }
      if (!viewable(otherVersion, diskSha)) {
        toast.message(`${otherVersion.label} is no longer kept, so it cannot be shown.`);
        return;
      }
      setCompare((current) => ({ sha: otherVersion.sha256, mode: current?.mode ?? "ab", showOther: false, wipe: current?.wipe ?? 0.5, opacity: current?.opacity ?? 1 }));
    },
    [versions, previousVersion, diskSha],
  );

  // The other version's frame index and media, for the compare view.
  useEffect(() => {
    if (!compare) {
      setOther(null);
      return;
    }
    if (other?.version.sha256 === compare.sha) return;
    let alive = true;
    rpc.call("versions.load", { videoId: video.id, sha256: compare.sha }).then(
      (result) => alive && setOther(result),
      (cause: unknown) => {
        if (!alive) return;
        toast.error(`Could not load the other version: ${errorText(cause)}`);
        setCompare(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [rpc, video.id, compare, other?.version.sha256]);

  // Opened through `bb video-review open … --compare vN`: start comparing once the versions are known.
  useEffect(() => {
    const ref = pendingIntent.current;
    if (!ref || !disk) return;
    pendingIntent.current = null;
    const found = findVersionRef(versions, ref);
    if (found && found.sha256 !== index.sha256) startCompare(found.sha256);
    else if (!found) toast.message(`No version ${ref} of this video.`);
  }, [disk, versions, index.sha256, startCompare]);

  useOpenIntent(video.id, (intent) => {
    if (intent.frame !== null) player.current?.seek(intent.frame);
    if (intent.compare) {
      const found = findVersionRef(versions, intent.compare);
      if (found && found.sha256 !== index.sha256) startCompare(found.sha256);
    }
  });

  /** Check a fix: view the render it was fixed in at the matching frame, A/B against the version it was written on. */
  const checkNote = useCallback(
    async (note: Note) => {
      if (note.frameIn === null) return;
      const fixedIn = note.fixedInSha ?? diskSha ?? index.sha256;
      try {
        const { mappings: list } = await rpc.call("notes.mapped", { videoId: video.id, toSha: fixedIn });
        const mapping = list.find((m) => m.noteId === note.id);
        const at = note.mediaSha256 === fixedIn ? note.frameIn : mapping && !mapping.unmappable ? mapping.frameIn : null;
        setActiveId(note.id);
        if (fixedIn !== index.sha256) {
          player.current?.pause();
          if (at !== null) setFrame(at);
          await loadVersion(fixedIn);
        } else if (at !== null) {
          player.current?.seek(at);
        }
        if (note.mediaSha256 !== fixedIn) {
          setCompare((current) => ({ sha: note.mediaSha256, mode: current?.mode ?? "ab", showOther: false, wipe: current?.wipe ?? 0.5, opacity: current?.opacity ?? 1 }));
        }
        if (at === null) toast.message(`Frame ${note.frameIn} of ${note.versionLabel} has no reliable match in the fixed render.`);
      } catch (cause) {
        toast.error(errorText(cause));
      }
    },
    [rpc, video.id, diskSha, index.sha256, loadVersion],
  );

  const verifyNote = fixedQueue[0] ?? null;
  // Verify mode walks the fixed notes; each verify or reopen drops the note from the queue.
  useEffect(() => {
    if (!verifying) return;
    if (!verifyNote) {
      setVerifying(false);
      toast.success("Every fix is checked.");
      return;
    }
    void checkNote(verifyNote);
    // Only when the note in front changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifying, verifyNote?.id]);

  const openReport = useCallback(() => {
    if (!compare) return;
    const pair = byAge(versions.filter((v) => v.sha256 === compare.sha || v.sha256 === index.sha256));
    if (pair.length !== 2) return;
    setReport({ open: true, data: null, error: null });
    rpc.call("versions.report", { videoId: video.id, fromSha: pair[0].sha256, toSha: pair[1].sha256 }).then(
      (data) => setReport({ open: true, data, error: null }),
      (cause: unknown) => setReport({ open: true, data: null, error: errorText(cause) }),
    );
  }, [rpc, video.id, compare, versions, index.sha256]);

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
      player.current?.step((key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? Math.max(1, Math.round(index.fps.num / index.fps.den)) : 1));
    } else if ((key === "ArrowUp" || key === "ArrowDown") && !event.metaKey && !event.ctrlKey) {
      handled();
      const cuts = cutsOf([...(scrub?.scenes ?? []), ...(scrub?.sections ?? [])]);
      const to = nextCut(cuts, frame, key === "ArrowDown" ? 1 : -1);
      if (to !== null) player.current?.seek(to);
      else if (cuts.length === 0) toast.message("No scene cuts: this version has no render manifest.");
    } else if ((key === "s" || key === "S") && !event.metaKey && !event.ctrlKey) {
      handled();
      setSkimming((value) => !value);
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
      const skimmed = player.current?.skimFrame() ?? null;
      if (skimmed !== null) {
        player.current?.seek(skimmed);
        openEditor(skimmed);
      } else openEditor();
    } else if (key === "b" || key === "B") {
      handled();
      player.current?.pause();
      setTool((value) => (value === "box" ? "none" : "box"));
    } else if (key === "a" || key === "A") {
      handled();
      player.current?.pause();
      setTool((value) => (value === "arrow" ? "none" : "arrow"));
    } else if ((key === "z" || key === "Z") && (event.metaKey || event.ctrlKey) && !pending?.note) {
      handled();
      setShapes((current) => current.slice(0, -1));
    } else if ((key === "Backspace" || key === "Delete") && !pending?.note) {
      handled();
      setShapes((current) => current.slice(0, -1));
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
    } else if (key === "c" || key === "C") {
      handled();
      if (compare) setCompare(null);
      else startCompare();
    } else if (key === "\\") {
      handled();
      if (compare) setCompare({ ...compare, mode: "ab", showOther: compare.mode === "ab" ? !compare.showOther : true });
    } else if (verifying && verifyNote && (key === "v" || key === "V")) {
      handled();
      actions.onVerify(verifyNote);
    } else if (verifying && verifyNote && (key === "r" || key === "R")) {
      handled();
      actions.onReopen(verifyNote);
    } else if (verifying && (key === "n" || key === "N")) {
      handled();
      toast.message("Verify or reopen this one to move on; Esc leaves verify mode.");
    } else if (key === "Escape") {
      handled();
      if (tool !== "none") setTool("none");
      else if (help) setHelp(false);
      else if (report.open) setReport({ open: false, data: null, error: null });
      else if (verifying) setVerifying(false);
      else if (pending) {
        setPending(null);
        setShapes([]);
      } else if (compare) setCompare(null);
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
    onCheck: (note) => void checkNote(note),
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

  const compareView: CompareView | null =
    compare && other && other.version.sha256 === compare.sha && target !== null
      ? {
          url: other.media.url,
          index: other.index,
          label: other.version.label,
          mainLabel: version.label,
          mode: compare.mode,
          showOther: compare.showOther,
          wipe: compare.wipe,
          opacity: compare.opacity,
          target: Math.max(0, Math.min(other.index.pts.length - 1, target)),
          onWipe: (wipe) => setCompare((current) => (current ? { ...current, wipe } : current)),
          onMediaError: () => {
            void rpc
              .call("versions.mediaUrl", { videoId: video.id, sha256: other.version.sha256, refresh: true })
              .then((media) => setOther((current) => (current ? { ...current, media } : current)))
              .catch(() => toast.error("The other version could not be loaded."));
          },
        }
      : null;

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
          onUndoShape={() => setShapes((current) => current.slice(0, -1))}
          onCancel={() => {
            setPending(null);
            setShapes([]);
            setTool("none");
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
        mappings={mappings}
        viewingLabel={version.label}
        header={
          <>
            {notesError ? <p className="text-xs text-destructive">{notesError}</p> : null}
            {fixedQueue.length > 0 && !verifying ? (
              <Button size="sm" variant="secondary" className="h-7 w-full" onClick={() => setVerifying(true)}>
                <Icon name="Check" className="size-4" /> Check {fixedQueue.length} fix{fixedQueue.length === 1 ? "" : "es"} one by one
              </Button>
            ) : null}
          </>
        }
      />
    </div>
  );

  return (
    <div
      ref={root}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDownCapture={(event) => {
        // A click on the picture, the timeline or a button must not take the keys away from the tab (B, A, M, arrows): focus
        // returns to the tab unless the click went into a field.
        if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
        requestAnimationFrame(() => {
          const now = document.activeElement;
          if (!root.current || (now && now !== document.body && root.current.contains(now) && now.closest("input, textarea, select, [contenteditable=true]"))) return;
          root.current.focus({ preventScroll: true });
        });
      }}
      className="relative flex h-full min-h-0 flex-col bg-background outline-none"
      aria-label={`Video review: ${video.name}`}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        {versions.length > 1 ? (
          <select
            aria-label="Version"
            className="h-6 rounded border border-input bg-transparent px-1 font-medium"
            value={index.sha256}
            onChange={(event) => void switchVersion(event.target.value)}
          >
            {versions.map((v) => (
              <option key={v.sha256} value={v.sha256} disabled={!viewable(v, diskSha)}>
                {v.label}
                {v.sha256 === diskSha ? " (on disk)" : viewable(v, diskSha) ? " (kept)" : " (not kept)"}
              </option>
            ))}
          </select>
        ) : (
          <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{version.label}</span>
        )}
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
          variant={compare ? "secondary" : "ghost"}
          className="h-7 px-2"
          disabled={versions.length < 2}
          aria-label={versions.length < 2 ? "Compare needs a second version of this video" : "Compare with another version (C)"}
          onClick={() => (compare ? setCompare(null) : startCompare())}
        >
          Compare
        </Button>
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

      {compare ? (
        <CompareBar
          videoId={video.id}
          viewing={version}
          versions={versions}
          currentSha={diskSha}
          state={compare}
          frame={frame}
          target={target}
          mapError={mapError}
          onChange={setCompare}
          onClose={() => setCompare(null)}
          onShowReport={openReport}
        />
      ) : null}

      {verifying && verifyNote ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-primary/40 bg-primary/10 px-3 py-1.5 text-xs">
          <span className="font-medium">
            Checking fix #{verifyNote.seq} · {fixedQueue.length} left
          </span>
          <span className="min-w-0 flex-1 truncate" title={verifyNote.text}>
            {verifyNote.text}
            {verifyNote.statusNote ? <span className="text-muted-foreground"> · agent: {verifyNote.statusNote}</span> : null}
          </span>
          <Button size="sm" className="h-6 px-2 text-xs" onClick={() => actions.onVerify(verifyNote)}>
            Verify (V)
          </Button>
          <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={() => actions.onReopen(verifyNote)}>
            Reopen (R)
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setVerifying(false)}>
            Stop
          </Button>
        </div>
      ) : null}

      {changedOnDisk || (disk?.sha256 && disk.sha256 !== index.sha256) ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs">
          <span className="flex-1">
            {`You are looking at ${version.label}; the file on disk is ${changedOnDisk?.label ?? "a newer render"}. New notes go on the file on disk. Notes stay on the version they were written on and show where they land on the one you view.`}
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
            notes={notesHere}
            mappedMarks={marksHere}
            compare={compareView}
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
            scrub={scrub}
            scrubError={scrubError}
            skimming={skimming}
            onToggleSkim={() => setSkimming((value) => !value)}
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
            <Button size="sm" variant="secondary" className="h-7" onClick={() => openEditor()}>
              <Icon name="MessageSquare" className="size-4" /> Note (M)
            </Button>
          </div>
          {/* The timeline sits last, under the controls (as in CapCut), so reaching a control never crosses it and moves the playhead. */}
          <Scrubber
            index={index}
            frame={frame}
            assets={scrub}
            assetsError={scrubError}
            skimming={skimming && tool === "none" && !pending}
            skimPaused={skimming && (tool !== "none" || Boolean(pending))}
            onToggleSkim={() => setSkimming((value) => !value)}
            onScrub={(n) => player.current?.scrubTo(n)}
            notes={notesHere}
            mappedMarks={marksHere}
            activeId={activeId}
            onSelectNote={selectNote}
            inPoint={inPoint}
            outPoint={outPoint}
          />
        </div>
        {notesPanel}
      </div>

      {report.open ? (
        <ReportPanel
          report={report.data}
          error={report.error}
          fps={fps}
          onClose={() => setReport({ open: false, data: null, error: null })}
          onJump={({ oldFrame, newFrame }) => {
            if (!report.data) return;
            const at = index.sha256 === report.data.to.sha256 ? newFrame : index.sha256 === report.data.from.sha256 ? oldFrame : null;
            if (at !== null) player.current?.seek(at);
          }}
        />
      ) : null}

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
