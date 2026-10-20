// Who may move a note from one status to another. The agent reports work
// (fixed, question); only the user verifies, closes as won't-fix, or reopens.
import type { NoteStatus } from "./types.ts";

export type Actor = "user" | "agent";

const RULES: Record<Actor, Partial<Record<NoteStatus, readonly NoteStatus[]>>> = {
  agent: {
    sent: ["fixed", "question"],
    question: ["fixed", "question"],
    fixed: ["fixed", "question"],
  },
  user: {
    draft: ["sent", "wontfix"],
    sent: ["sent", "draft", "wontfix"],
    question: ["sent", "draft", "wontfix"],
    fixed: ["verified", "draft", "wontfix"],
    verified: ["draft"],
    wontfix: ["draft"],
  },
};

export function canTransition(from: NoteStatus, to: NoteStatus, actor: Actor): boolean {
  return RULES[actor][from]?.includes(to) ?? false;
}

export class TransitionError extends Error {
  readonly from: NoteStatus;
  readonly to: NoteStatus;
  readonly actor: Actor;

  constructor(from: NoteStatus, to: NoteStatus, actor: Actor) {
    super(
      actor === "agent" && to === "verified"
        ? "Only the user can mark a note verified."
        : `A note that is ${from} cannot become ${to}${actor === "agent" ? " from the agent" : ""}.`,
    );
    this.from = from;
    this.to = to;
    this.actor = actor;
  }
}

export function assertTransition(from: NoteStatus, to: NoteStatus, actor: Actor): void {
  if (!canTransition(from, to, actor)) throw new TransitionError(from, to, actor);
}
