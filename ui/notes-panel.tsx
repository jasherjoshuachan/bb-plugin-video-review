// The note list beside the player, grouped like Doc Review's comment list
// (MIT, (c) 2026 Foma; see NOTICE): what needs the user, drafts, sent, done.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { NOTE_CATEGORIES, isStale, noteLocation, shortSha, type Note, type NoteCategory, type NoteKind } from "../lib/types";

export interface NoteActions {
  onSelect(note: Note): void;
  onEdit(note: Note): void;
  onDelete(note: Note): void;
  onReopen(note: Note): void;
  onVerify(note: Note): void;
  onWontfix(note: Note): void;
}

const GROUPS: { title: string; statuses: Note["status"][] }[] = [
  { title: "Needs you", statuses: ["fixed", "question"] },
  { title: "Drafts", statuses: ["draft"] },
  { title: "Sent", statuses: ["sent"] },
  { title: "Done", statuses: ["verified", "wontfix"] },
];

const STATUS_TEXT: Record<Note["status"], string> = {
  draft: "draft",
  sent: "with the agent",
  fixed: "fixed, check it",
  verified: "verified",
  question: "agent asks",
  wontfix: "won't fix",
};

function NoteItem({
  note,
  active,
  currentSha,
  stillBase,
  actions,
}: {
  note: Note;
  active: boolean;
  currentSha: string;
  stillBase: string | null;
  actions: NoteActions;
}) {
  const stale = isStale(note, currentSha);
  const thumb =
    stillBase && note.frameIn !== null
      ? `${stillBase}?note=${note.id}&kind=${note.shapes.length > 0 ? "annotated" : "raw"}`
      : null;
  return (
    <li
      className={cn(
        "cursor-pointer rounded-md border p-2 text-xs",
        active ? "border-primary bg-accent/40" : "border-border hover:bg-state-hover",
      )}
      onClick={() => actions.onSelect(note)}
    >
      <div className="flex gap-2">
        {thumb ? <img src={thumb} alt="" className="h-12 w-20 shrink-0 rounded-sm bg-muted object-cover" loading="lazy" /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
            <span className="font-medium text-foreground">#{note.seq}</span>
            <span className="font-mono">{noteLocation(note)}</span>
            {note.kind === "range" ? <span>→ {note.frameOut}</span> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {note.category !== "other" ? <span className="rounded bg-muted px-1.5 py-px">{note.category}</span> : null}
            <span className="rounded bg-muted px-1.5 py-px">{STATUS_TEXT[note.status]}</span>
            {stale ? (
              <span className="rounded bg-amber-500/20 px-1.5 py-px text-amber-700 dark:text-amber-300" title={`Written on ${note.versionLabel} (${shortSha(note.mediaSha256)})`}>
                on {note.versionLabel}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-foreground">{note.text}</p>
      {note.statusNote ? (
        <p className="mt-1 rounded bg-muted/60 p-1.5 text-muted-foreground">
          <span className="font-medium">{note.status === "question" ? "Agent asks: " : "Agent: "}</span>
          {note.statusNote}
          {note.fixedInSha ? <span className="font-mono"> · in {shortSha(note.fixedInSha)}</span> : null}
        </p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap gap-1" onClick={(event) => event.stopPropagation()}>
        {note.status === "fixed" ? (
          <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={() => actions.onVerify(note)}>
            <Icon name="Check" className="size-3.5" /> Verify
          </Button>
        ) : null}
        {note.status === "draft" || note.status === "question" ? (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => actions.onEdit(note)}>
            Edit
          </Button>
        ) : null}
        {note.status === "fixed" || note.status === "verified" || note.status === "wontfix" || note.status === "sent" ? (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => actions.onReopen(note)}>
            Reopen
          </Button>
        ) : null}
        {note.status !== "verified" && note.status !== "wontfix" ? (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => actions.onWontfix(note)}>
            Won't fix
          </Button>
        ) : null}
        {note.status === "draft" ? (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-destructive" onClick={() => actions.onDelete(note)}>
            Delete
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function NotesList({
  notes,
  activeId,
  currentSha,
  stillBase,
  actions,
  header,
}: {
  notes: Note[];
  activeId: string | null;
  currentSha: string;
  stillBase: string | null;
  actions: NoteActions;
  header?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-3">
      {header}
      {notes.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          No notes yet. Pause on a frame and press M.
        </p>
      ) : null}
      {GROUPS.map((group) => {
        const items = notes.filter((note) => group.statuses.includes(note.status));
        if (items.length === 0) return null;
        return (
          <section key={group.title}>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.title} · {items.length}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {items.map((note) => (
                <NoteItem
                  key={note.id}
                  note={note}
                  active={note.id === activeId}
                  currentSha={currentSha}
                  stillBase={stillBase}
                  actions={actions}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export interface EditorValue {
  kind: NoteKind;
  text: string;
  category: NoteCategory;
}

/** Note editor. The frame was bound when it opened; changing it means closing and pressing M again. */
export function NoteEditor({
  label,
  kinds,
  initial,
  shapeCount,
  busy,
  onClearShapes,
  onUndoShape,
  onCancel,
  onSubmit,
}: {
  label: string;
  kinds: NoteKind[];
  initial: EditorValue;
  shapeCount: number;
  busy: boolean;
  onClearShapes: () => void;
  onUndoShape?: () => void;
  onCancel: () => void;
  onSubmit: (value: EditorValue) => void;
}) {
  const [value, setValue] = useState(initial);
  const text = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => text.current?.focus(), []);
  const submit = () => {
    if (value.text.trim() && !busy) onSubmit({ ...value, text: value.text.trim() });
  };
  return (
    <div className="flex flex-col gap-2 border-b border-border p-3 text-xs">
      <div className="font-mono text-muted-foreground">{label}</div>
      {kinds.length > 1 ? (
        <div className="flex gap-1" role="group" aria-label="Note covers">
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={value.kind === kind}
              className={cn(
                "rounded px-2 py-0.5",
                value.kind === kind ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setValue({ ...value, kind })}
            >
              {kind === "general" ? "Whole video" : kind === "range" ? "In–out range" : "This frame"}
            </button>
          ))}
        </div>
      ) : null}
      <select
        aria-label="Category"
        className="h-7 rounded-md border border-input bg-transparent px-2"
        value={value.category}
        onChange={(event) => setValue({ ...value, category: event.target.value as NoteCategory })}
      >
        {NOTE_CATEGORIES.map((category) => (
          <option key={category} value={category}>
            {category === "other" ? "No category (optional)" : category}
          </option>
        ))}
      </select>
      <textarea
        ref={text}
        rows={4}
        className="w-full resize-y rounded-md border border-input bg-transparent p-2 text-sm"
        placeholder="What is wrong here, and what should it be?"
        value={value.text}
        onChange={(event) => setValue({ ...value, text: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          event.stopPropagation();
        }}
      />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-muted-foreground">
          {shapeCount > 0 ? (
            <>
              {shapeCount} mark{shapeCount === 1 ? "" : "s"} ·{" "}
              {onUndoShape ? (
                <>
                  <button type="button" className="underline" title="Undo last mark (⌘Z)" onClick={onUndoShape}>
                    undo last
                  </button>{" "}
                  ·{" "}
                </>
              ) : null}
              <button type="button" className="underline" onClick={onClearShapes}>
                clear all
              </button>
            </>
          ) : (
            "B box, A arrow to mark the picture"
          )}
        </span>
        <Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" className="h-7" disabled={busy || !value.text.trim()} onClick={submit}>
          Save ⌘↵
        </Button>
      </div>
    </div>
  );
}
