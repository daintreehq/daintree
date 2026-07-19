import { describe, expect, it } from "vitest";
import {
  MAIN_WORKTREE_NOTE_TTL_MS,
  deriveCommitMessageSeed,
  deriveEffectiveNote,
} from "../worktreeAiNote";

const NOW = 1_700_000_000_000;

describe("deriveEffectiveNote", () => {
  it("returns the trimmed note for a feature worktree", () => {
    expect(deriveEffectiveNote({ aiNote: "  Refactor the store  " }, NOW)).toBe(
      "Refactor the store"
    );
  });

  it("returns undefined for an absent note", () => {
    expect(deriveEffectiveNote({}, NOW)).toBeUndefined();
  });

  it("returns undefined for a whitespace-only note", () => {
    expect(deriveEffectiveNote({ aiNote: "  \n\t " }, NOW)).toBeUndefined();
  });

  it("keeps a main-worktree note that is still inside the TTL", () => {
    expect(
      deriveEffectiveNote(
        {
          aiNote: "Fresh note",
          aiNoteTimestamp: NOW - (MAIN_WORKTREE_NOTE_TTL_MS - 1),
          isMainWorktree: true,
        },
        NOW
      )
    ).toBe("Fresh note");
  });

  it("keeps a main-worktree note exactly at the TTL boundary", () => {
    // Expiry is `age > TTL`, so the boundary itself is still current.
    expect(
      deriveEffectiveNote(
        {
          aiNote: "Boundary note",
          aiNoteTimestamp: NOW - MAIN_WORKTREE_NOTE_TTL_MS,
          isMainWorktree: true,
        },
        NOW
      )
    ).toBe("Boundary note");
  });

  it("expires a main-worktree note past the TTL", () => {
    expect(
      deriveEffectiveNote(
        {
          aiNote: "Stale note",
          aiNoteTimestamp: NOW - (MAIN_WORKTREE_NOTE_TTL_MS + 1),
          isMainWorktree: true,
        },
        NOW
      )
    ).toBeUndefined();
  });

  it("does not expire a non-main worktree note however old", () => {
    // A feature worktree's note describes work still sitting uncommitted in it.
    expect(
      deriveEffectiveNote(
        {
          aiNote: "Ancient but still relevant",
          aiNoteTimestamp: NOW - MAIN_WORKTREE_NOTE_TTL_MS * 100,
          isMainWorktree: false,
        },
        NOW
      )
    ).toBe("Ancient but still relevant");
  });

  it("keeps a main-worktree note that carries no timestamp", () => {
    // Without a timestamp there is no evidence of staleness to act on.
    expect(
      deriveEffectiveNote({ aiNote: "Undated note", isMainWorktree: true }, NOW)
    ).toBe("Undated note");
  });
});

describe("deriveCommitMessageSeed", () => {
  it("takes only the first line", () => {
    expect(
      deriveCommitMessageSeed({ aiNote: "Add retry logic\n\nWhy: flaky network" }, NOW)
    ).toBe("Add retry logic");
  });

  it("trims the extracted line", () => {
    expect(deriveCommitMessageSeed({ aiNote: "\n   Indented subject  \nbody" }, NOW)).toBe(
      "Indented subject"
    );
  });

  it("returns empty string — never a substitute — when no note is current", () => {
    expect(deriveCommitMessageSeed({}, NOW)).toBe("");
    expect(
      deriveCommitMessageSeed(
        {
          aiNote: "Expired",
          aiNoteTimestamp: NOW - (MAIN_WORKTREE_NOTE_TTL_MS + 1),
          isMainWorktree: true,
        },
        NOW
      )
    ).toBe("");
  });
});
