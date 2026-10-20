// Data hooks for the review tab: the opened video and its frame index, the
// file on disk (to notice a re-render), and the notes, kept current by the
// server's realtime signal. The notes hook follows Doc Review's useComments
// (MIT, (c) 2026 Foma); see NOTICE.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginFileOpenerSource,
} from "@get-bb/plugin-sdk/app";
import type { FrameIndexDto, MediaDto, NoteMappingDto, RpcContract } from "../lib/contract";
import type { Note, ReviewVideo, VideoVersion } from "../lib/types";

/** How often an open tab checks whether the file was re-rendered. */
const DISK_POLL_MS = 4000;

export function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause && "message" in cause) return String((cause as { message: unknown }).message);
  return String(cause);
}

export function useReviewRpc() {
  return useRpc<RpcContract>();
}

export interface Loaded {
  video: ReviewVideo;
  version: VideoVersion;
  index: FrameIndexDto;
  media: MediaDto;
  /** How the tab was asked to open (`bb video-review open`): a frame and a version to compare with. */
  intent?: { frame: number | null; compare: string | null } | null;
}

export function useVideo(path: string, source: PluginFileOpenerSource) {
  const rpc = useReviewRpc();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { kind, threadId, environmentId, projectId } = source;
  const hostId = source.experimental_hostId ?? null;

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setError(null);
    rpc
      .call("video.open", { path, source: { kind, threadId, environmentId, projectId, experimental_hostId: hostId } })
      .then(
        (result) => alive && setLoaded(result),
        (cause: unknown) => alive && setError(errorText(cause)),
      );
    return () => {
      alive = false;
    };
  }, [rpc, path, kind, threadId, environmentId, projectId, hostId]);

  /** Swap in the file on disk now (after a re-render), keeping the video id. */
  const reload = useCallback(async () => {
    if (!loaded) return;
    const next = await rpc.call("video.reload", { videoId: loaded.video.id });
    setLoaded((current) => (current ? { ...current, ...next } : current));
  }, [rpc, loaded]);

  /** Show another version (the file on disk or a kept copy) in the same tab. */
  const loadVersion = useCallback(
    async (sha256: string) => {
      if (!loaded) return;
      const next = await rpc.call("versions.load", { videoId: loaded.video.id, sha256 });
      setLoaded((current) => (current ? { ...current, ...next, intent: null } : current));
    },
    [rpc, loaded],
  );

  const refreshMedia = useCallback(async () => {
    if (!loaded) return;
    const media = await rpc.call("versions.mediaUrl", { videoId: loaded.video.id, sha256: loaded.version.sha256, refresh: true });
    setLoaded((current) => (current ? { ...current, media } : current));
  }, [rpc, loaded]);

  return { loaded, error, reload, refreshMedia, loadVersion };
}

/** The sha256 of the file on disk now, polled while the tab is visible. */
export function useDiskSha(videoId: string | null) {
  const rpc = useReviewRpc();
  const [disk, setDisk] = useState<{ sha256: string | null; versions: VideoVersion[] } | null>(null);
  useEffect(() => {
    if (!videoId) return;
    let alive = true;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      rpc.call("video.state", { videoId }).then(
        (result) => alive && setDisk(result),
        () => undefined,
      );
    };
    check();
    const timer = window.setInterval(check, DISK_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [rpc, videoId]);
  return disk;
}

export function useNotes(videoId: string | null) {
  const rpc = useReviewRpc();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [stillBase, setStillBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const refetch = useCallback(() => {
    if (!videoId) return;
    const request = ++latest.current;
    rpc.call("notes.list", { videoId }).then(
      (result) => {
        if (request !== latest.current) return;
        setNotes(result.notes);
        setStillBase(result.stillBase);
        setError(null);
      },
      (cause: unknown) => request === latest.current && setError(errorText(cause)),
    );
  }, [rpc, videoId]);

  useEffect(() => {
    setNotes(null);
    refetch();
  }, [refetch]);

  useRealtime("video-review-changed", (payload: unknown) => {
    const ids = (payload as { videoIds?: unknown } | null)?.videoIds;
    if (!videoId || !Array.isArray(ids) || ids.includes(videoId)) refetch();
  });

  // Signals are not replayed: reconcile after a reconnect.
  const connection = useRealtimeConnectionState();
  const seenConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (seenConnected.current) refetch();
    seenConnected.current = true;
  }, [connection, refetch]);

  return { notes, stillBase, error, refetch, setNotes };
}

/** Where notes written on other versions land on the version being viewed. */
export function useMappings(videoId: string | null, sha256: string | null, notesKey: string) {
  const rpc = useReviewRpc();
  const [mappings, setMappings] = useState<Map<string, NoteMappingDto>>(new Map());
  useEffect(() => {
    if (!videoId || !sha256) return;
    let alive = true;
    rpc.call("notes.mapped", { videoId, toSha: sha256 }).then(
      (result) => alive && setMappings(new Map(result.mappings.map((m) => [m.noteId, m]))),
      () => alive && setMappings(new Map()),
    );
    return () => {
      alive = false;
    };
  }, [rpc, videoId, sha256, notesKey]);
  return mappings;
}

/** Frame maps between the viewed version and another: forward[frame] is the other's matching frame. */
export function useFrameMaps(videoId: string | null, fromSha: string | null, toSha: string | null) {
  const rpc = useReviewRpc();
  const [maps, setMaps] = useState<{ key: string; forward: number[]; backward: number[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${fromSha}:${toSha}`;
  useEffect(() => {
    if (!videoId || !fromSha || !toSha) return;
    let alive = true;
    setError(null);
    rpc.call("versions.maps", { videoId, fromSha, toSha }).then(
      (result) => alive && setMaps({ key, ...result }),
      (cause: unknown) => alive && setError(errorText(cause)),
    );
    return () => {
      alive = false;
    };
  }, [rpc, videoId, fromSha, toSha, key]);
  return { maps: maps && maps.key === key ? maps : null, error };
}

/** `bb video-review open` on a video this tab already shows: jump and compare without reopening. */
export function useOpenIntent(videoId: string | null, onIntent: (intent: { frame: number | null; compare: string | null }) => void) {
  const handler = useRef(onIntent);
  handler.current = onIntent;
  useRealtime("video-review-intent", (payload: unknown) => {
    const data = payload as { videoId?: unknown; frame?: unknown; compare?: unknown } | null;
    if (!data || data.videoId !== videoId) return;
    handler.current({
      frame: typeof data.frame === "number" ? data.frame : null,
      compare: typeof data.compare === "string" ? data.compare : null,
    });
  });
}
