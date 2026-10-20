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
import type { FrameIndexDto, MediaDto, RpcContract } from "../lib/contract";
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

  const refreshMedia = useCallback(async () => {
    if (!loaded) return;
    const media = await rpc.call("video.mediaUrl", { videoId: loaded.video.id, refresh: true });
    setLoaded((current) => (current ? { ...current, media } : current));
  }, [rpc, loaded]);

  return { loaded, error, reload, refreshMedia };
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
