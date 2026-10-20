// Where an opened video lives. Adapted from Doc Review's src/files.ts
// (MIT, (c) 2026 Foma); see NOTICE. Video Review reads the file with ffmpeg,
// so only files on the bb server's own machine are reviewed.
import { homedir } from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface OpenerSource {
  kind: "host" | "thread-storage" | "workspace";
  threadId: string | null;
  environmentId: string | null;
  projectId: string | null;
  experimental_hostId?: string | null;
}

export function joinPath(root: string, relative: string): string {
  const normalized = path.posix.normalize(relative.replace(/^\/+/, ""));
  if (normalized.startsWith("..")) throw new Error("The path leaves its workspace.");
  return path.posix.join(root, normalized);
}

export class VideoFiles {
  private readonly bb: BbPluginApi;
  private localHostIdPromise: Promise<string | null> | null = null;

  constructor(bb: BbPluginApi) {
    this.bb = bb;
  }

  /** The enrolled host id of the machine the bb server runs on. */
  localHostId(): Promise<string | null> {
    this.localHostIdPromise ??= this.bb.sdk.system.config().then(
      (config) => config.primaryHostId ?? null,
      () => null,
    );
    return this.localHostIdPromise;
  }

  /** Normalizes a host id: the server's own machine is stored as null. */
  async canonicalHost(hostId: string | null | undefined): Promise<string | null> {
    if (!hostId) return null;
    return hostId === (await this.localHostId()) ? null : hostId;
  }

  /**
   * Resolves a file-opener path to an absolute path on this machine.
   * Workspace paths are worktree-relative, thread-storage paths are relative
   * to the thread's storage root, and host paths are already absolute.
   */
  async resolve(rawPath: string, source: OpenerSource): Promise<string> {
    const { absPath, hostId } = await this.locate(rawPath, source);
    if (hostId !== null) {
      throw new Error("Video Review reads videos on the machine bb runs on; this file is on another host.");
    }
    return absPath;
  }

  private async locate(rawPath: string, source: OpenerSource): Promise<{ absPath: string; hostId: string | null }> {
    if (source.kind === "workspace") {
      if (source.environmentId) {
        const environment = await this.bb.sdk.environments.get({ environmentId: source.environmentId });
        if (!environment.path) throw new Error("This environment has no checkout on disk yet.");
        return { absPath: joinPath(environment.path, rawPath), hostId: await this.canonicalHost(environment.hostId) };
      }
      if (source.projectId) {
        const project = await this.bb.sdk.projects.get({ projectId: source.projectId });
        const checkout =
          project.sources.find((candidate) => candidate.hostId === source.experimental_hostId) ??
          project.sources.find((candidate) => candidate.isDefault) ??
          project.sources[0];
        if (!checkout) throw new Error("This project has no checkout on any host.");
        return { absPath: joinPath(checkout.path, rawPath), hostId: await this.canonicalHost(checkout.hostId) };
      }
      throw new Error("This workspace file has no environment.");
    }
    if (source.kind === "thread-storage") {
      if (!source.threadId) throw new Error("This stored file has no thread.");
      const storage = await this.bb.sdk.threads.storageLocation({ threadId: source.threadId });
      return { absPath: joinPath(storage.storageRootPath, rawPath), hostId: await this.canonicalHost(storage.hostId) };
    }
    if (rawPath === "~" || rawPath.startsWith("~/")) rawPath = path.posix.join(homedir(), rawPath.slice(1));
    if (!path.posix.isAbsolute(rawPath)) throw new Error("Expected an absolute path.");
    let hostId: string | null = source.experimental_hostId ?? null;
    if (!hostId && source.environmentId) {
      const environment = await this.bb.sdk.environments.get({ environmentId: source.environmentId });
      hostId = environment.hostId;
    }
    return { absPath: path.posix.normalize(rawPath), hostId: await this.canonicalHost(hostId) };
  }
}
