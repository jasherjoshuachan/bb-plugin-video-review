// Copied from bb-plugin-inline-media lib/authorize.ts (MIT, same author); see NOTICE.
// Only the protected-location checks are used here.
// Server-side rules for absolute paths that are not Composer Dropzone drops.
//
// An absolute media path is served only when the user attached exactly that
// file to a message in the thread (bb records it as a `localFile` with its
// host and path), and never from a protected location. Pure functions over
// strings (node:path only), so every decision is unit tested; server.ts
// fetches the thread's messages and does the file I/O.
import path from "node:path";
import { isStrictlyInside } from "./inside.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One file the user attached by path. `hostId` is null when bb didn't record it. */
export interface AttachedFile {
  path: string;
  hostId: string | null;
}

export interface ProtectedOptions {
  /** The bb server user's home folder. */
  home: string;
  /** bb's data folder (`~/.bb` by default). */
  dataDir: string | null;
  /** Composer Dropzone's drops folder, the one exception inside bb's data folder. Null when drops are off. */
  dropsDir: string | null;
}

/** Folders under the home folder that hold keys, tokens or app data. */
const PROTECTED_HOME_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config",
  ".bb",
  path.join("Library", "Keychains"),
  path.join("Library", "Cookies"),
];

/** The protected folders for a home and data folder, absolute. */
export function protectedRoots(options: ProtectedOptions): string[] {
  const roots = PROTECTED_HOME_DIRS.map((dir) => path.join(options.home, dir));
  if (options.dataDir !== null) roots.push(path.resolve(options.dataDir));
  return roots;
}

/**
 * True when `absPath` is inside a protected location: `~/.ssh`, `~/.gnupg`,
 * cloud and container credentials, `~/.config`, any `~/.claude*` folder,
 * bb's data folder (except Composer Dropzone's drops folder, without its
 * hidden entries) and the macOS keychains and cookies.
 */
export function isProtectedLocation(absPath: string, options: ProtectedOptions): boolean {
  const target = path.resolve(absPath);
  if (options.dropsDir !== null && isStrictlyInside(options.dropsDir, target)) {
    const rel = path.relative(path.resolve(options.dropsDir), target);
    if (!rel.split(path.sep).some((segment) => segment.startsWith("."))) return false;
  }
  for (const root of protectedRoots(options)) {
    if (target === root || isStrictlyInside(root, target)) return true;
  }
  if (isStrictlyInside(options.home, target)) {
    const first = path.relative(path.resolve(options.home), target).split(path.sep)[0] ?? "";
    if (first.startsWith(".claude")) return true;
  }
  return false;
}

/**
 * True when a preview of `directory` would expose a protected location
 * because it contains one: the home folder itself, any folder above it, or a
 * folder above `~/.ssh`, bb's data folder and the rest. bb's previews cover a
 * folder, not a single file, so a media file sitting directly in the home
 * folder must not open a preview of the whole home folder.
 */
export function exposesProtectedLocation(directory: string, options: ProtectedOptions): boolean {
  const dir = path.resolve(directory);
  const home = path.resolve(options.home);
  if (dir === home || isStrictlyInside(dir, home)) return true;
  return protectedRoots(options).some((root) => dir === root || isStrictlyInside(dir, root));
}

/**
 * Files attached by absolute path in a thread's prompt history
 * (`bb.sdk.threads.promptHistory`): every `localFile` input with an absolute
 * path, and attachment mentions in text inputs.
 */
export function attachedFilesFromPromptHistory(history: unknown): AttachedFile[] {
  const out: AttachedFile[] = [];
  if (!Array.isArray(history)) return out;
  for (const entry of history) {
    const input = isRecord(entry) && Array.isArray(entry.input) ? entry.input : [];
    for (const item of input) {
      if (!isRecord(item)) continue;
      if (item.type === "localFile" && typeof item.path === "string" && path.isAbsolute(item.path)) {
        out.push({ path: item.path, hostId: typeof item.hostId === "string" ? item.hostId : null });
      } else if (item.type === "text" && Array.isArray(item.mentions)) {
        for (const mention of item.mentions) {
          const resource = isRecord(mention) ? mention.resource : undefined;
          if (isRecord(resource) && resource.kind === "attachment" && typeof resource.path === "string" && path.isAbsolute(resource.path)) {
            out.push({ path: resource.path, hostId: null });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Files attached by absolute path to one message (`bb.sdk.threads.message`'s
 * `message`): its `localFileDetails` / `localFilePaths` and attachment
 * mentions. bb doesn't record the host there, so `hostId` is null.
 */
export function attachedFilesFromMessage(message: unknown): AttachedFile[] {
  const out: AttachedFile[] = [];
  if (!isRecord(message)) return out;
  const attachments = message.attachments;
  if (isRecord(attachments)) {
    const details = Array.isArray(attachments.localFileDetails) ? attachments.localFileDetails : [];
    for (const detail of details) {
      if (isRecord(detail) && typeof detail.path === "string" && path.isAbsolute(detail.path)) {
        out.push({ path: detail.path, hostId: null });
      }
    }
    const paths = Array.isArray(attachments.localFilePaths) ? attachments.localFilePaths : [];
    for (const entry of paths) {
      if (typeof entry === "string" && path.isAbsolute(entry)) out.push({ path: entry, hostId: null });
    }
  }
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  for (const mention of mentions) {
    const resource = isRecord(mention) ? mention.resource : undefined;
    if (isRecord(resource) && resource.kind === "attachment" && typeof resource.path === "string" && path.isAbsolute(resource.path)) {
      out.push({ path: resource.path, hostId: null });
    }
  }
  return out;
}

/**
 * Whether `requested` is exactly one of the attached files on `hostId`.
 * Paths are compared after `path.resolve` (which only collapses `.`/`//`;
 * the request has already been refused if it had `..`). A recorded host must
 * match; an attachment without a recorded host counts as the bb server's
 * own machine, the only host this plugin serves absolute paths from.
 */
export function isAttachedPath(
  requested: string,
  attached: readonly AttachedFile[],
  hostId: string | null,
  primaryHostId: string | null,
): boolean {
  if (!path.isAbsolute(requested)) return false;
  const wanted = path.resolve(requested);
  return attached.some((file) => {
    if (path.resolve(file.path) !== wanted) return false;
    const fileHost = file.hostId ?? primaryHostId;
    return fileHost !== null && fileHost === hostId;
  });
}
