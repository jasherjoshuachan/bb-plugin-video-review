// Compare controls: pick the other version, the view (A/B, side by side,
// wipe, difference), ask the server for an exact pixel compare, and list
// what changed between the two renders.
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { PixelDiffDto, ReportDto } from "../lib/contract";
import type { VideoVersion } from "../lib/types";
import { errorText, useReviewRpc } from "./hooks";
import type { CompareMode } from "./player";

export interface CompareState {
  sha: string;
  mode: CompareMode;
  showOther: boolean;
  wipe: number;
  opacity: number;
}

const MODES: { mode: CompareMode; label: string; title: string }[] = [
  { mode: "ab", label: "A/B", title: "Flip between the two (\\)" },
  { mode: "side", label: "Side by side", title: "Both at once, on the matching frame" },
  { mode: "wipe", label: "Wipe", title: "Drag the line across the picture" },
  { mode: "diff", label: "Difference", title: "Only what differs stays bright" },
];

function versionText(version: VideoVersion, currentSha: string | null): string {
  const notes = [version.sha256 === currentSha ? "on disk" : version.kept === "clone" || version.kept === "copy" ? "kept" : version.kept];
  return `${version.label} · ${version.sha256.slice(0, 8)} · ${notes.join(", ")}`;
}

/** Whether a version can be shown (the file on disk, or a kept copy). */
export function viewable(version: VideoVersion, currentSha: string | null): boolean {
  return version.sha256 === currentSha || version.kept === "clone" || version.kept === "copy";
}

export function CompareBar({
  videoId,
  viewing,
  versions,
  currentSha,
  state,
  frame,
  target,
  mapError,
  onChange,
  onClose,
  onShowReport,
}: {
  videoId: string;
  viewing: VideoVersion;
  versions: VideoVersion[];
  currentSha: string | null;
  state: CompareState;
  frame: number;
  target: number | null;
  mapError: string | null;
  onChange: (next: CompareState) => void;
  onClose: () => void;
  onShowReport: () => void;
}) {
  const rpc = useReviewRpc();
  const [diff, setDiff] = useState<{ diff: PixelDiffDto; urls: { a: string; b: string; difference: string }; aFrame: number; bFrame: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const other = versions.find((v) => v.sha256 === state.sha);

  const pixelCompare = async () => {
    setBusy(true);
    try {
      setDiff(await rpc.call("compare.frames", { videoId, aSha: viewing.sha256, aFrame: frame, bSha: state.sha, ...(target !== null ? { bFrame: target } : {}) }));
    } catch (cause) {
      toast.error(`Pixel compare failed: ${errorText(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
      <span className="font-medium">Compare</span>
      <span className="text-muted-foreground">A {viewing.label} with B</span>
      <select
        aria-label="Version to compare with"
        className="h-6 rounded border border-input bg-transparent px-1"
        value={state.sha}
        onChange={(event) => onChange({ ...state, sha: event.target.value })}
      >
        {versions
          .filter((v) => v.sha256 !== viewing.sha256)
          .map((v) => (
            <option key={v.sha256} value={v.sha256} disabled={!viewable(v, currentSha)}>
              {versionText(v, currentSha)}
            </option>
          ))}
      </select>
      <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Compare view">
        {MODES.map(({ mode, label, title }) => (
          <button
            key={mode}
            type="button"
            title={title}
            aria-pressed={state.mode === mode}
            className={cn("h-5 rounded-[4px] px-1.5", state.mode === mode ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
            onClick={() => onChange({ ...state, mode })}
          >
            {label}
          </button>
        ))}
      </div>
      {state.mode === "ab" ? (
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => onChange({ ...state, showOther: !state.showOther })}>
          Showing {state.showOther ? `B ${other?.label ?? ""}` : `A ${viewing.label}`} (\)
        </Button>
      ) : null}
      {state.mode === "diff" ? (
        <label className="flex items-center gap-1 text-muted-foreground">
          strength
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={state.opacity}
            onChange={(event) => onChange({ ...state, opacity: Number(event.target.value) })}
          />
        </label>
      ) : null}
      <span className="font-mono text-muted-foreground">
        {mapError ? <span className="text-destructive">matching failed: {mapError}</span> : target === null ? "matching frames…" : `A ${frame} ↔ B ${target}`}
      </span>
      <div className="flex-1" />
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void pixelCompare()}>
        {busy ? "Comparing…" : "Pixel diff"}
      </Button>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onShowReport}>
        What changed
      </Button>
      <Button size="sm" variant="ghost" className="h-6 px-2" aria-label="Close compare" onClick={onClose}>
        <Icon name="X" className="size-3.5" />
      </Button>
      {diff ? (
        <div className="absolute right-3 top-full z-20 mt-1 w-80 rounded-md border border-border bg-popover p-2 shadow-lg">
          <div className="mb-1 flex items-center">
            <span className="flex-1 font-medium">
              A {viewing.label} frame {diff.aFrame} vs B {other?.label} frame {diff.bFrame}
            </span>
            <button type="button" aria-label="Close" onClick={() => setDiff(null)}>
              <Icon name="X" className="size-3.5" />
            </button>
          </div>
          <a href={diff.urls.difference} target="_blank" rel="noreferrer">
            <img src={diff.urls.difference} alt="Difference" className="w-full rounded-sm bg-black" />
          </a>
          <p className="mt-1 text-muted-foreground">
            mean {diff.diff.mean}, max {diff.diff.max}, {(diff.diff.changedShare * 100).toFixed(2)}% of pixels over {diff.diff.threshold}
          </p>
          <p className="text-muted-foreground">
            {diff.diff.box
              ? `Changed area: x ${diff.diff.box.x}, y ${diff.diff.box.y}, ${diff.diff.box.w}×${diff.diff.box.h} px`
              : "No pixel differs by more than the threshold."}
          </p>
          <p className="mt-1 flex gap-2">
            <a className="underline" href={diff.urls.a} target="_blank" rel="noreferrer">
              A frame
            </a>
            <a className="underline" href={diff.urls.b} target="_blank" rel="noreferrer">
              B frame
            </a>
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** What changed from the older to the newer of two versions, each entry a jump. */
export function ReportPanel({
  report,
  error,
  fps,
  onJump,
  onClose,
}: {
  report: ReportDto | null;
  error: string | null;
  fps: number;
  /** Frames are given in the old and new version's own numbering. */
  onJump: (at: { oldFrame: number | null; newFrame: number | null }) => void;
  onClose: () => void;
}) {
  const sec = (f: number) => `${(f / fps).toFixed(2)} s`;
  return (
    <div className="absolute left-3 top-24 z-20 max-h-[60%] w-96 overflow-auto rounded-md border border-border bg-popover p-3 text-xs shadow-lg">
      <div className="mb-2 flex items-center">
        <span className="flex-1 font-medium">
          {report ? `What changed from ${report.from.label} to ${report.to.label}` : "What changed"}
        </span>
        <button type="button" aria-label="Close" onClick={onClose}>
          <Icon name="X" className="size-3.5" />
        </button>
      </div>
      {error ? <p className="text-destructive">{error}</p> : null}
      {!report && !error ? <p className="text-muted-foreground">Matching every frame of both renders…</p> : null}
      {report ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">
            {(report.content.matched * 100).toFixed(1)}% of frames matched by picture.
          </p>
          <section>
            <h4 className="font-medium">Timing</h4>
            {report.content.shifts.length === 0 ? <p className="text-muted-foreground">No shifts.</p> : null}
            {report.content.shifts.map((s) => (
              <button
                key={`s-${s.oldFrame}`}
                type="button"
                className="block w-full rounded px-1 py-0.5 text-left hover:bg-state-hover"
                onClick={() => onJump({ oldFrame: s.oldFrame, newFrame: s.newFrame })}
              >
                {report.from.label} {s.oldFrame} ({sec(s.oldFrame)}): {s.delta > 0 ? "+" : ""}
                {s.delta} frames
              </button>
            ))}
          </section>
          <section>
            <h4 className="font-medium">Pictures</h4>
            {report.content.changes.length === 0 && report.content.removals.length === 0 ? (
              <p className="text-muted-foreground">Nothing above the encoder's noise.</p>
            ) : null}
            {report.content.changes.map((c) => (
              <button
                key={`c-${c.from}`}
                type="button"
                className="block w-full rounded px-1 py-0.5 text-left hover:bg-state-hover"
                onClick={() => onJump({ oldFrame: c.oldFrom, newFrame: c.from })}
              >
                {c.kind} in {report.to.label} {c.from === c.to ? c.from : `${c.from}–${c.to}`} ({sec(c.from)}), max {c.maxDistance}
              </button>
            ))}
            {report.content.removals.map((r) => (
              <button
                key={`r-${r.from}`}
                type="button"
                className="block w-full rounded px-1 py-0.5 text-left hover:bg-state-hover"
                onClick={() => onJump({ oldFrame: r.from, newFrame: r.at })}
              >
                cut from {report.from.label}: {r.from}–{r.to} ({sec(r.from)})
              </button>
            ))}
          </section>
          <section>
            <h4 className="font-medium">Manifest edges</h4>
            {report.boundaries === null ? (
              <p className="text-muted-foreground">No manifest on both versions.</p>
            ) : report.boundaries.length === 0 ? (
              <p className="text-muted-foreground">No scene or section edge moved.</p>
            ) : (
              report.boundaries.map((d) => (
                <button
                  key={`b-${d.by}-${d.id}-${d.edge}`}
                  type="button"
                  className="block w-full rounded px-1 py-0.5 text-left hover:bg-state-hover"
                  onClick={() => onJump({ oldFrame: d.oldFrame, newFrame: d.newFrame })}
                >
                  {d.by} {d.id} {d.edge}: {d.oldFrame} → {d.newFrame} ({d.delta > 0 ? "+" : ""}
                  {d.delta})
                </button>
              ))
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
