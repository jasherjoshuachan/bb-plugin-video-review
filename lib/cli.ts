// `bb video-review`: how agents read video notes and report back.
//
// Adapted from Doc Review's src/cli.ts (MIT, (c) 2026 Foma); see NOTICE.
// What changes for video: `resolve` needs the sha256 of the re-rendered file,
// which must be the file on disk now and differ from the one the note was
// written on; agents can mark a note fixed or answer it, never verified.
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type PluginCliRegistration,
} from "@get-bb/plugin-sdk";
import { CLI_NAME } from "./message.ts";
import type { NoteWithVideo, ReviewStore, VideoRow } from "./store.ts";
import { TransitionError } from "./status.ts";
import { NOTE_STATUSES, describeShapes, noteLocation, shortSha, truncate, type NoteStatus } from "./types.ts";

const LIST_LIMIT = 200;
const NOTE_MAX = 2000;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

export interface FrameFiles {
  /** Frame on the file the note was written on: raw, annotated (when marked) and crop (when boxed). */
  files: { kind: "raw" | "annotated" | "crop"; path: string }[];
  /** The frame index that was extracted. */
  frame: number;
  /** sha256 of the file the frame came from. */
  sha256: string;
}

export interface CompareResult {
  /** Human-readable lines. */
  text: string;
  /** Machine-readable result. */
  data: unknown;
}

export interface CliDeps {
  store: ReviewStore;
  onChanged: (videoIds: string[]) => void;
  /** sha256 of the video file as it is on disk now, or null when it is gone. */
  currentSha: (video: VideoRow) => Promise<string | null>;
  /** The note's frozen stills, or (current) the same frame from the file on disk now. */
  frameFiles: (note: NoteWithVideo, options: { current: boolean }) => Promise<FrameFiles>;
  /** Stores a render manifest for the version of `file` on disk now. */
  registerTimeline?: (file: string, jsonText: string) => Promise<{ label: string; sha256: string; sections: number; scenes: number }>;
  /** A note's frame on its version against where it lands on another version (default: the file on disk now). */
  compareNote?: (note: NoteWithVideo, to: string | null) => Promise<CompareResult>;
  /** Two versions of a file: the change report, or one frame compared when `frame` is given. */
  compareVersions?: (file: string, a: string, b: string, frame: number | null) => Promise<CompareResult>;
  /** Opens the review tab in a thread on `file`, optionally at a frame and comparing with a version. */
  open?: (file: string, options: { threadId: string; frame: number | null; compare: string | null }) => Promise<string>;
}

function absoluteFrom(cwd: string | undefined, file: string): string {
  return path.posix.isAbsolute(file) ? path.posix.normalize(file) : path.posix.resolve(cwd ?? "/", file);
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new PluginCliError(`${what} is not available in this version of the plugin.`, { code: "unsupported" });
  return value;
}

function formatNote(note: NoteWithVideo): string {
  const lines = [`${note.id}  #${note.seq}  [${note.status}]  ${noteLocation(note)}  ${note.category}`];
  const markup = describeShapes(note.shapes);
  if (markup) lines.push(`  marked: ${markup}`);
  lines.push(`  note: ${truncate(note.text, 1000)}`);
  if (note.statusNote) lines.push(`  reply: ${truncate(note.statusNote, 500)}`);
  if (note.fixedInSha) lines.push(`  fixed in: ${shortSha(note.fixedInSha)}`);
  return lines.join("\n");
}

function groupByFile(notes: NoteWithVideo[]): string {
  const groups = new Map<string, NoteWithVideo[]>();
  for (const note of notes) {
    const key = note.video.hostId ? `${note.video.absPath} (host ${note.video.hostId})` : note.video.absPath;
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  return [...groups.entries()].map(([file, items]) => [file, ...items.map(formatNote)].join("\n")).join("\n\n");
}

function publicNote(note: NoteWithVideo) {
  const { video, ...rest } = note;
  return { ...rest, file: video.absPath, hostId: video.hostId, location: noteLocation(note) };
}

export function videoReviewCli(deps: CliDeps): PluginCliRegistration {
  const { store, onChanged } = deps;

  function requireNote(id: string): NoteWithVideo {
    const note = store.getNote(id.trim());
    if (!note) {
      throw new PluginCliError(`No video note with id ${id}.`, {
        code: "note_not_found",
        hint: `Run \`bb ${CLI_NAME} list\` to see ids.`,
      });
    }
    return note;
  }

  function checkNote(note: string | undefined, required: boolean): string | null {
    const trimmed = note?.trim() ?? "";
    if (!trimmed) {
      if (required) {
        throw new PluginCliError("--note is required.", {
          code: "missing_required",
          hint: 'Add --note "…" with the answer or reason.',
        });
      }
      return null;
    }
    if (trimmed.length > NOTE_MAX) {
      throw new PluginCliError(`--note is longer than ${NOTE_MAX} characters.`, { code: "invalid_value" });
    }
    return trimmed;
  }

  function asCliError(error: unknown): never {
    if (error instanceof TransitionError) throw new PluginCliError(error.message, { code: "invalid_status" });
    throw error;
  }

  return defineCli({
    name: CLI_NAME,
    summary: "Read notes left on rendered videos in the Video Review panel and report fixes",
    description:
      "Notes are pinned to a frame (or range) of an exact video file, identified by its sha256. Fix, re-render, then close each note with `resolve --sha <new sha256>`, or answer with `reply`. Only the user verifies.",
    commands: {
      list: cliCommand({
        summary: "List video notes (default: the ones sent to this thread and still waiting)",
        options: {
          file: {
            type: "string",
            description: "Only notes on this video (absolute, or relative to the current directory)",
            aliases: ["path"],
          },
          status: {
            type: "enum",
            values: [...NOTE_STATUSES, "all"],
            default: "sent",
            description: "Filter by status: draft, sent, fixed, verified, question, wontfix, or all",
          },
          "all-threads": {
            type: "boolean",
            description: "Include notes sent to other threads (default: only this thread's when run inside one)",
          },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input, ctx) {
          const statuses: NoteStatus[] =
            input.options.status === "all" ? [...NOTE_STATUSES] : [input.options.status as NoteStatus];
          let videoIds: string[] | undefined;
          if (input.options.file) {
            const absolute = path.posix.isAbsolute(input.options.file)
              ? path.posix.normalize(input.options.file)
              : path.posix.resolve(ctx.cwd ?? "/", input.options.file);
            videoIds = store.findVideosByPath(absolute).map((video) => video.id);
          }
          const restrictToThread =
            !input.options["all-threads"] && !input.options.file && input.options.status === "sent" && ctx.threadId
              ? ctx.threadId
              : null;
          const notes = store.queryNotes({
            statuses,
            threadId: restrictToThread,
            ...(videoIds ? { videoIds } : {}),
            limit: LIST_LIMIT,
          });
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ notes: notes.map(publicNote) }) };
          if (notes.length === 0) {
            return {
              exitCode: 0,
              stdout: restrictToThread
                ? "No notes are waiting for this thread. Add --all-threads to see every thread."
                : "No matching notes.",
            };
          }
          const more = notes.length === LIST_LIMIT ? `\n\n(showing the first ${LIST_LIMIT})` : "";
          return { exitCode: 0, stdout: groupByFile(notes) + more };
        },
      }),
      show: cliCommand({
        summary: "Show one note in full",
        positionals: [{ name: "id", description: "Note id, like n_ab12cd", required: true }],
        options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
        async run(input) {
          const note = requireNote(input.positionals.id);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(publicNote(note)) };
          const markup = describeShapes(note.shapes);
          const text = [
            `${note.id}  #${note.seq}  [${note.status}]`,
            `file: ${note.video.absPath}`,
            `written on: ${note.versionLabel} sha256 ${note.mediaSha256}`,
            `location: ${noteLocation(note)}`,
            ...(note.kind === "range" ? [`frames: ${note.frameIn}–${note.frameOut}`] : []),
            `category: ${note.category}`,
            ...(markup ? [`marked: ${markup}`] : []),
            `note: ${note.text}`,
            ...(note.statusNote ? [`reply: ${note.statusNote}`] : []),
            ...(note.fixedInSha ? [`fixed in: ${note.fixedInSha}`] : []),
          ].join("\n");
          return { exitCode: 0, stdout: text };
        },
      }),
      frame: cliCommand({
        summary: "Write the note's frame as PNG files and print their paths",
        description:
          "By default: the stills frozen when the note was written (raw frame, the marked-up frame, and a crop of the marked area). With --current: the same frame number taken from the file on disk now, to check a fix.",
        positionals: [{ name: "id", description: "Note id", required: true }],
        options: {
          current: { type: "boolean", description: "Take the frame from the file on disk now" },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input) {
          const note = requireNote(input.positionals.id);
          if (note.kind === "general" || note.frameIn === null) {
            throw new PluginCliError("This note is about the whole video; it has no frame.", { code: "no_frame" });
          }
          const result = await deps.frameFiles(note, { current: Boolean(input.options.current) });
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(result) };
          const lines = [
            `frame ${result.frame} of sha256 ${shortSha(result.sha256)}${
              result.sha256 !== note.mediaSha256 ? ` (the note was written on ${note.versionLabel}, sha256 ${shortSha(note.mediaSha256)})` : ""
            }`,
            ...result.files.map((file) => `${file.kind}: ${file.path}`),
          ];
          return { exitCode: 0, stdout: lines.join("\n") };
        },
      }),
      resolve: cliCommand({
        summary: "Mark notes fixed in a re-rendered file, with a one-line note on what changed",
        positionals: [{ name: "ids", description: "One or more note ids", required: true, variadic: true }],
        options: {
          sha: {
            type: "string",
            required: true,
            description: "sha256 of the re-rendered video now on disk (shasum -a 256 <file>)",
          },
          note: {
            type: "string",
            description: `What you changed, shown to the user next to the note (max ${NOTE_MAX} chars)`,
            aliases: ["message"],
            short: "m",
            stdin: true,
          },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input) {
          const sha = input.options.sha.trim().toLowerCase();
          if (!SHA_PATTERN.test(sha)) {
            throw new PluginCliError("--sha must be a 64-character hex sha256.", {
              code: "invalid_value",
              hint: "Run `shasum -a 256 <video>` on the re-rendered file.",
            });
          }
          const text = checkNote(input.options.note, false);
          const notes = input.positionals.ids.map(requireNote);
          const shaByVideo = new Map<string, string | null>();
          for (const note of notes) {
            if (!shaByVideo.has(note.video.id)) shaByVideo.set(note.video.id, await deps.currentSha(note.video));
            const onDisk = shaByVideo.get(note.video.id);
            if (onDisk === null || onDisk === undefined) {
              throw new PluginCliError(`The video for ${note.id} is gone: ${note.video.absPath}`, { code: "file_missing" });
            }
            if (onDisk !== sha) {
              throw new PluginCliError(
                `--sha does not match the file on disk for ${note.id} (${shortSha(onDisk)}).`,
                { code: "sha_mismatch", hint: "Pass the sha256 of the re-rendered file at the note's path." },
              );
            }
            if (note.mediaSha256 === sha) {
              throw new PluginCliError(
                `${note.id} was written on this exact file; nothing was re-rendered.`,
                { code: "unchanged", hint: `Re-render first, or answer with \`bb ${CLI_NAME} reply\`.` },
              );
            }
          }
          let fixed;
          try {
            fixed = notes.map((note) => store.markFixed(note.id, sha, text));
          } catch (error) {
            asCliError(error);
          }
          onChanged([...new Set(notes.map((note) => note.video.id))]);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ fixed: fixed.map((n) => n.id), sha }) };
          return {
            exitCode: 0,
            stdout: `Marked fixed in ${shortSha(sha)}: ${fixed.map((n) => `${n.id} (#${n.seq})`).join(", ")}. The user verifies them.`,
          };
        },
      }),
      timeline: cliCommand({
        summary: "Attach a render manifest (sections and scenes) to the version of a video on disk now",
        description:
          'The manifest is JSON: { "fps": 25, "duration": 515.8, "sections": [{ "id", "t0", "t1" }], "scenes": [{ "id", "kind", "t0", "t1" }] } in seconds. With a manifest on both versions, notes map across renders by scene and offset. A `<video>.timeline.json` next to the video is picked up on its own.',
        positionals: [
          { name: "file", description: "The video", required: true },
          { name: "manifest", description: "The manifest JSON file", required: true },
        ],
        options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
        async run(input, ctx) {
          const register = need(deps.registerTimeline, "timeline");
          const file = absoluteFrom(ctx.cwd, input.positionals.file);
          const manifestPath = absoluteFrom(ctx.cwd, input.positionals.manifest);
          let text: string;
          try {
            text = await readFile(manifestPath, "utf8");
          } catch {
            throw new PluginCliError(`Cannot read ${manifestPath}.`, { code: "file_missing" });
          }
          let result;
          try {
            result = await register(file, text);
          } catch (error) {
            throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "invalid_value" });
          }
          onChanged(store.findVideosByPath(file).map((video) => video.id));
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(result) };
          return {
            exitCode: 0,
            stdout: `Manifest stored for ${result.label} (sha256 ${shortSha(result.sha256)}): ${result.sections} sections, ${result.scenes} scenes.`,
          };
        },
      }),
      compare: cliCommand({
        summary: "Compare renders: a note's frame against the new render, or two versions of a video",
        description:
          "`compare <note id> [--to vN]`: the note's frame on the version it was written on against where it lands on vN (default: the file on disk now), with a pixel difference image. `compare --file <video> --versions v1 v2`: what changed between two renders (timing shifts, changed pictures, scene edges). Add `--frame <n>` (a frame of the first version) for a pixel compare at that moment.",
        positionals: [{ name: "id", description: "Note id (or use --file with --versions)", required: false }],
        options: {
          to: { type: "string", description: "With a note id: the version to compare against (v2, or a sha256 prefix)" },
          file: { type: "string", description: "The video, with --versions", aliases: ["path"] },
          versions: { type: "string", description: "Two versions, like v1,v2 (or v1 v2 quoted)" },
          frame: { type: "integer", description: "With --versions: a frame of the first version to compare pixel by pixel", min: 0, max: 100_000_000 },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input, ctx) {
          let result: CompareResult;
          if (input.positionals.id) {
            if (input.options.file || input.options.versions) {
              throw new PluginCliError("Give a note id, or --file with --versions, not both.", { code: "invalid_value" });
            }
            const note = requireNote(input.positionals.id);
            if (note.kind === "general" || note.frameIn === null) {
              throw new PluginCliError("This note is about the whole video; it has no frame to compare.", { code: "no_frame" });
            }
            result = await need(deps.compareNote, "compare")(note, input.options.to?.trim() || null);
          } else {
            if (!input.options.file || !input.options.versions) {
              throw new PluginCliError("Give a note id, or --file <video> --versions v1,v2.", {
                code: "missing_required",
                hint: `bb ${CLI_NAME} compare --file out/video.mp4 --versions v1,v2`,
              });
            }
            const pair = input.options.versions.split(/[\s,]+/).filter(Boolean);
            if (pair.length !== 2) {
              throw new PluginCliError("--versions takes exactly two versions, like v1,v2.", { code: "invalid_value" });
            }
            result = await need(deps.compareVersions, "compare")(
              absoluteFrom(ctx.cwd, input.options.file),
              pair[0],
              pair[1],
              input.options.frame ?? null,
            );
          }
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(result.data) };
          return { exitCode: 0, stdout: result.text };
        },
      }),
      open: cliCommand({
        summary: "Open a video in the Video Review tab of this thread",
        description:
          "The video must be in this thread's workspace or thread storage. --frame jumps to a frame; --compare vN opens the compare view against that version (use it after a re-render, at the first fixed note).",
        positionals: [{ name: "file", description: "The video", required: true }],
        options: {
          frame: { type: "integer", description: "Frame to show", min: 0, max: 100_000_000 },
          compare: { type: "string", description: "A version to compare with (v1, or a sha256 prefix)" },
        },
        async run(input, ctx) {
          if (!ctx.threadId) {
            throw new PluginCliError("Run this inside a bb thread; the tab opens in that thread.", { code: "no_thread" });
          }
          const message = await need(deps.open, "open")(absoluteFrom(ctx.cwd, input.positionals.file), {
            threadId: ctx.threadId,
            frame: input.options.frame ?? null,
            compare: input.options.compare?.trim() || null,
          });
          return { exitCode: 0, stdout: message };
        },
      }),
      reply: cliCommand({
        summary: "Answer a note without fixing it (a question, or why it was not applied)",
        positionals: [{ name: "id", description: "Note id", required: true }],
        options: {
          note: {
            type: "string",
            required: true,
            description: `The answer shown to the user (max ${NOTE_MAX} chars)`,
            aliases: ["message"],
            short: "m",
            stdin: true,
          },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input) {
          const text = checkNote(input.options.note, true)!;
          const note = requireNote(input.positionals.id);
          let replied;
          try {
            replied = store.markQuestion(note.id, text);
          } catch (error) {
            asCliError(error);
          }
          onChanged([note.video.id]);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ replied: replied.id }) };
          return { exitCode: 0, stdout: `Replied on ${replied.id} (#${replied.seq}).` };
        },
      }),
    },
  });
}
