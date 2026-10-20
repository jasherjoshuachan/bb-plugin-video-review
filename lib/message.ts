// The message an agent receives: the exact file and version the notes were
// written on, one block per note with its frame label, then how to report
// back through `bb video-review`.
//
// Layout adapted from Doc Review's src/message.ts (MIT, (c) 2026 Foma); see NOTICE.
import {
  describeShapes,
  isStale,
  noteLocation,
  shortSha,
  type Note,
  type VideoVersion,
} from "./types.ts";

export const CLI_NAME = "video-review";

export interface HandoffInput {
  absPath: string;
  /** The version on disk when the notes are sent. */
  current: VideoVersion;
  notes: Note[];
  /** Versions by sha, to name the version a stale note was written on. */
  versions: Map<string, VideoVersion>;
  /** Note id → 1-based numbers of its attached images. */
  imageNumbers: Map<string, number[]>;
  /** Note id → local image paths, used when images cannot be attached. */
  imagePaths: Map<string, string[]>;
}

function fpsText(version: Pick<VideoVersion, "fpsNum" | "fpsDen">): string {
  const value = version.fpsNum / version.fpsDen;
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(3);
  return `${rounded} fps (${version.fpsNum}/${version.fpsDen})`;
}

function rangeText(note: Note): string | null {
  if (note.kind !== "range" || note.frameIn === null || note.frameOut === null) return null;
  return `frames ${note.frameIn}–${note.frameOut} (${note.frameOut - note.frameIn + 1} frames)`;
}

export function buildHandoffMessage(input: HandoffInput): string {
  const name = input.absPath.split("/").pop() ?? input.absPath;
  const { current } = input;
  const count = input.notes.length;
  const lines: string[] = [
    `Video review notes on \`${name}\` — ${count} to address.`,
    `File: \`${input.absPath}\``,
    `Version: ${current.label} · sha256 ${current.sha256} · ${current.width}x${current.height} · ${fpsText(current)} · ${current.frames} frames`,
    "",
  ];
  for (const note of input.notes) {
    const parts = [`[${note.id}] ${noteLocation(note)}`];
    const range = rangeText(note);
    if (range) parts.push(range);
    parts.push(note.category);
    const numbers = input.imageNumbers.get(note.id) ?? [];
    const paths = input.imagePaths.get(note.id) ?? [];
    if (numbers.length > 0) parts.push(`${numbers.length === 1 ? "image" : "images"} ${numbers.join(", ")} attached`);
    else if (paths.length > 0) parts.push(`images: ${paths.map((p) => `\`${p}\``).join(", ")}`);
    lines.push(parts.join(" · "));
    if (isStale(note, current.sha256)) {
      const written = input.versions.get(note.mediaSha256);
      lines.push(
        `Written on ${written?.label ?? note.versionLabel} (sha256 ${shortSha(note.mediaSha256)}), not the current ${current.label}: its frame numbers belong to that file. Find the moment on the current file before changing anything, or reply if you cannot.`,
      );
    }
    const markup = describeShapes(note.shapes);
    if (markup) lines.push(`Marked: ${markup}`);
    lines.push(note.text.trim());
    lines.push("");
  }
  lines.push(
    "Frames are 0-based indexes into the file with the sha256 above; timecode is non-drop on the nominal rate. Pixel positions are in the video's own resolution.",
  );
  lines.push(
    `Before you start, check the file on disk still has that sha256 (\`shasum -a 256\`). See a note's frame with \`bb ${CLI_NAME} frame <id>\`.`,
  );
  lines.push(
    `When a note is fixed and the video is re-rendered, close it with the new file's sha256: \`bb ${CLI_NAME} resolve <id> --sha <sha256> --note "what changed"\`.`,
  );
  lines.push(
    `If you cannot apply one or need an answer first, reply instead: \`bb ${CLI_NAME} reply <id> --note "question or reason"\`.`,
  );
  return lines.join("\n");
}
