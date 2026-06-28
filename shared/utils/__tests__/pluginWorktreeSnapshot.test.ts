import { describe, expect, it } from "vitest";
import { toPluginWorktreeSnapshot, toPluginWorktreeStatus } from "../pluginWorktreeSnapshot.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../forgeProviderIds.js";
import type { WorktreeSnapshot } from "../../types/workspace-host.js";
import type { FileChangeDetail, WorktreeChanges } from "../../types/git.js";

function change(path: string, status: FileChangeDetail["status"]): FileChangeDetail {
  return { path, status, insertions: null, deletions: null };
}

function makeChanges(changes: FileChangeDetail[]): WorktreeChanges {
  return {
    worktreeId: "wt-1",
    rootPath: "/repo/feature-x",
    changes,
    changedFileCount: changes.length,
  };
}

function makeSnapshot(extra: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id: "wt-1",
    worktreeId: "wt-1",
    path: "/repo/feature-x",
    name: "feature-x",
    isCurrent: false,
    ...extra,
  };
}

describe("toPluginWorktreeSnapshot — linked projection", () => {
  it("yields linked: null when neither issueNumber nor prNumber is present", () => {
    const out = toPluginWorktreeSnapshot(makeSnapshot());
    expect(out.linked).toBeNull();
  });

  it("populates linked.pr from prNumber/prUrl/prState/prTitle", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({
        prNumber: 42,
        prUrl: "https://github.com/o/r/pull/42",
        prState: "open",
        prTitle: "Fix the thing",
      })
    );
    expect(out.linked).not.toBeNull();
    expect(out.linked?.providerId).toBe(BUILTIN_GITHUB_PROVIDER_ID);
    expect(out.linked?.pr).toEqual({
      ref: {
        providerId: BUILTIN_GITHUB_PROVIDER_ID,
        owner: "",
        repo: "",
        number: 42,
        rawData: null,
      },
      title: "Fix the thing",
      url: "https://github.com/o/r/pull/42",
      state: "open",
    });
    expect(out.linked?.issue).toBeUndefined();
  });

  it("populates linked.issue from issueNumber/issueTitle", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({ issueNumber: 7, issueTitle: "Bug report" })
    );
    expect(out.linked?.providerId).toBe(BUILTIN_GITHUB_PROVIDER_ID);
    expect(out.linked?.issue).toEqual({
      ref: {
        providerId: BUILTIN_GITHUB_PROVIDER_ID,
        owner: "",
        repo: "",
        number: 7,
        rawData: null,
      },
      title: "Bug report",
    });
    expect(out.linked?.pr).toBeUndefined();
  });

  it("populates both arms when both PR and issue are linked", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({
        prNumber: 42,
        prUrl: "https://github.com/o/r/pull/42",
        prState: "merged",
        issueNumber: 7,
      })
    );
    expect(out.linked?.pr?.ref.number).toBe(42);
    expect(out.linked?.pr?.state).toBe("merged");
    expect(out.linked?.issue?.ref.number).toBe(7);
  });

  it("uses the same providerId on linked, linked.pr.ref, and linked.issue.ref", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({
        prNumber: 42,
        prUrl: "u",
        prState: "open",
        issueNumber: 7,
      })
    );
    const providerId = out.linked?.providerId;
    expect(providerId).toBe(BUILTIN_GITHUB_PROVIDER_ID);
    expect(out.linked?.pr?.ref.providerId).toBe(providerId);
    expect(out.linked?.issue?.ref.providerId).toBe(providerId);
  });

  it("maps the three WorktreeSnapshot prState values through directly", () => {
    const open = toPluginWorktreeSnapshot(makeSnapshot({ prNumber: 1, prState: "open" }));
    expect(open.linked?.pr?.state).toBe("open");

    const merged = toPluginWorktreeSnapshot(makeSnapshot({ prNumber: 1, prState: "merged" }));
    expect(merged.linked?.pr?.state).toBe("merged");

    const closed = toPluginWorktreeSnapshot(makeSnapshot({ prNumber: 1, prState: "closed" }));
    expect(closed.linked?.pr?.state).toBe("closed");
  });

  it("defaults missing prUrl to an empty string and missing prState to open", () => {
    const out = toPluginWorktreeSnapshot(makeSnapshot({ prNumber: 99 }));
    expect(out.linked?.pr?.url).toBe("");
    expect(out.linked?.pr?.state).toBe("open");
    expect(out.linked?.pr?.title).toBeUndefined();
  });

  it("freezes the snapshot, the linked object, and the linked refs", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({
        prNumber: 1,
        prUrl: "u",
        prState: "open",
        issueNumber: 2,
      })
    );
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.linked)).toBe(true);
    expect(Object.isFrozen(out.linked?.pr)).toBe(true);
    expect(Object.isFrozen(out.linked?.pr?.ref)).toBe(true);
    expect(Object.isFrozen(out.linked?.issue)).toBe(true);
    expect(Object.isFrozen(out.linked?.issue?.ref)).toBe(true);
  });

  it("does not surface the removed GitHub-shaped flat fields on the output", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({
        prNumber: 1,
        prUrl: "u",
        prState: "open",
        prTitle: "t",
        issueNumber: 2,
        issueTitle: "i",
      })
    );
    // The removed fields are no longer keys on the projection — even though
    // the source carries them, they must not leak out.
    expect(Object.keys(out)).not.toContain("issueNumber");
    expect(Object.keys(out)).not.toContain("issueTitle");
    expect(Object.keys(out)).not.toContain("prNumber");
    expect(Object.keys(out)).not.toContain("prUrl");
    expect(Object.keys(out)).not.toContain("prState");
    expect(Object.keys(out)).not.toContain("prTitle");
  });

  it("preserves the non-linkage allowlist fields", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({
        id: "wt-2",
        worktreeId: "wt-2",
        path: "/repo/other",
        name: "other",
        isCurrent: true,
        branch: "feature-x",
        isMainWorktree: false,
        aheadCount: 3,
        behindCount: 1,
        mood: "active",
        lastActivityTimestamp: 1234,
        createdAt: 5678,
      })
    );
    expect(out.id).toBe("wt-2");
    expect(out.path).toBe("/repo/other");
    expect(out.name).toBe("other");
    expect(out.isCurrent).toBe(true);
    expect(out.branch).toBe("feature-x");
    expect(out.isMainWorktree).toBe(false);
    expect(out.aheadCount).toBe(3);
    expect(out.behindCount).toBe(1);
    expect(out.mood).toBe("active");
    expect(out.lastActivityTimestamp).toBe(1234);
    expect(out.createdAt).toBe(5678);
  });

  it("defaults lastActivityTimestamp to null when source omits it", () => {
    const out = toPluginWorktreeSnapshot(makeSnapshot());
    expect(out.lastActivityTimestamp).toBeNull();
  });
});

describe("toPluginWorktreeSnapshot — linked is the source of truth (#8452)", () => {
  it("passes a non-GitHub linked projection through without collapsing to defaults", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({
        // Flat fields are the legacy GitHub-shaped derivation; they must NOT
        // override the canonical linked payload.
        prNumber: 42,
        prUrl: "https://github.com/o/r/pull/42",
        prState: "open",
        issueNumber: 7,
        linked: {
          providerId: "acme.gitlab",
          pr: {
            ref: {
              providerId: "acme.gitlab",
              owner: "acme-corp",
              repo: "my-project",
              number: 1234,
              rawData: null,
            },
            title: "Add widget",
            url: "https://gitlab.acme.com/acme-corp/my-project/-/merge_requests/1234",
            state: "open",
          },
          issue: {
            ref: {
              providerId: "acme.gitlab",
              owner: "acme-corp",
              repo: "my-project",
              number: 88,
              rawData: null,
            },
            title: "Widget request",
          },
        },
      })
    );

    expect(out.linked?.providerId).toBe("acme.gitlab");
    expect(out.linked?.pr?.ref).toEqual({
      providerId: "acme.gitlab",
      owner: "acme-corp",
      repo: "my-project",
      number: 1234,
      rawData: null,
    });
    expect(out.linked?.pr?.url).toBe(
      "https://gitlab.acme.com/acme-corp/my-project/-/merge_requests/1234"
    );
    expect(out.linked?.issue?.ref.owner).toBe("acme-corp");
    expect(out.linked?.issue?.ref.repo).toBe("my-project");
    expect(out.linked?.issue?.ref.number).toBe(88);
  });

  it("preserves a forge CI status when passing linked through", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({
        linked: {
          providerId: "acme.gitlab",
          pr: {
            ref: {
              providerId: "acme.gitlab",
              owner: "acme-corp",
              repo: "my-project",
              number: 5,
              rawData: null,
            },
            url: "u",
            state: "open",
            ciStatus: {
              state: "failure",
              total: 3,
              passed: 1,
              failed: 2,
              pending: 0,
              rawData: null,
            },
          },
        },
      })
    );
    expect(out.linked?.pr?.ciStatus).toEqual({
      state: "failure",
      total: 3,
      passed: 1,
      failed: 2,
      pending: 0,
      rawData: null,
    });
  });

  it("deep-clones rather than freezing the host's live linked reference", () => {
    const liveLinked = {
      providerId: "acme.gitlab",
      pr: {
        ref: {
          providerId: "acme.gitlab",
          owner: "acme-corp",
          repo: "my-project",
          number: 9,
          rawData: null,
        },
        url: "u",
        state: "open" as const,
      },
    };
    const out = toPluginWorktreeSnapshot(makeSnapshot({ linked: liveLinked }));

    // Projection is frozen…
    expect(Object.isFrozen(out.linked)).toBe(true);
    expect(Object.isFrozen(out.linked?.pr)).toBe(true);
    expect(Object.isFrozen(out.linked?.pr?.ref)).toBe(true);
    // …but the host's original object is untouched and still mutable.
    expect(Object.isFrozen(liveLinked)).toBe(false);
    expect(Object.isFrozen(liveLinked.pr)).toBe(false);
    expect(Object.isFrozen(liveLinked.pr.ref)).toBe(false);
    expect(out.linked).not.toBe(liveLinked);
  });

  it("returns null only when linked is null AND no flat fields are present", () => {
    expect(toPluginWorktreeSnapshot(makeSnapshot({ linked: null })).linked).toBeNull();
  });
});

describe("toPluginWorktreeSnapshot — host-built vs legacy fallback parity (#9958)", () => {
  // The #9958 regression: the host-built `linked` path and the legacy flat-
  // field fallback previously emitted different providerIds (`"daintree.github.github"`
  // vs `"github"`), so third-party plugins that switch on `linked.providerId`
  // would silently take different branches for the same worktree depending on
  // which path produced the projection. This test pins the cross-path equality
  // on all three providerId sites in the projection.
  it("emits the same providerId from both paths at every linked.{providerId,pr.ref.providerId,issue.ref.providerId} site", () => {
    const hostBuilt = toPluginWorktreeSnapshot(
      makeSnapshot({
        prNumber: 42,
        prUrl: "https://github.com/o/r/pull/42",
        prState: "open",
        issueNumber: 7,
        linked: {
          providerId: BUILTIN_GITHUB_PROVIDER_ID,
          pr: {
            ref: {
              providerId: BUILTIN_GITHUB_PROVIDER_ID,
              owner: "o",
              repo: "r",
              number: 42,
              rawData: null,
            },
            title: "Fix the thing",
            url: "https://github.com/o/r/pull/42",
            state: "open",
          },
          issue: {
            ref: {
              providerId: BUILTIN_GITHUB_PROVIDER_ID,
              owner: "o",
              repo: "r",
              number: 7,
              rawData: null,
            },
            title: "Bug report",
          },
        },
      })
    );
    const legacyFallback = toPluginWorktreeSnapshot(
      makeSnapshot({
        prNumber: 42,
        prUrl: "https://github.com/o/r/pull/42",
        prState: "open",
        issueNumber: 7,
      })
    );

    expect(hostBuilt.linked?.providerId).toBe(legacyFallback.linked?.providerId);
    expect(hostBuilt.linked?.pr?.ref.providerId).toBe(legacyFallback.linked?.pr?.ref.providerId);
    expect(hostBuilt.linked?.issue?.ref.providerId).toBe(
      legacyFallback.linked?.issue?.ref.providerId
    );
    expect(legacyFallback.linked?.providerId).toBe(BUILTIN_GITHUB_PROVIDER_ID);
  });

  it("does not emit any of the legacy providerId forms from the fallback path", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({
        prNumber: 1,
        prUrl: "u",
        prState: "open",
        issueNumber: 2,
      })
    );
    expect(out.linked?.providerId).not.toBe("github");
    expect(out.linked?.providerId).not.toBe("builtin.github");
    expect(out.linked?.pr?.ref.providerId).not.toBe("github");
    expect(out.linked?.pr?.ref.providerId).not.toBe("builtin.github");
    expect(out.linked?.issue?.ref.providerId).not.toBe("github");
    expect(out.linked?.issue?.ref.providerId).not.toBe("builtin.github");
  });
});

describe("toPluginWorktreeStatus — changed-file projection", () => {
  it("returns null when the host has not polled changes", () => {
    expect(toPluginWorktreeStatus(null)).toBeNull();
    expect(toPluginWorktreeStatus(undefined)).toBeNull();
  });

  it("projects each changed file to a path + normalized state", () => {
    const out = toPluginWorktreeStatus(
      makeChanges([change("src/a.ts", "modified"), change("src/b.ts", "untracked")])
    );
    expect(out?.files).toEqual([
      { path: "src/a.ts", state: "modified" },
      { path: "src/b.ts", state: "untracked" },
    ]);
    expect(out?.changedFileCount).toBe(2);
  });

  it("collapses copied→added and conflicted→modified, drops ignored", () => {
    const out = toPluginWorktreeStatus(
      makeChanges([
        change("c.ts", "copied"),
        change("d.ts", "conflicted"),
        change("e.ts", "ignored"),
      ])
    );
    // ignored is filtered out entirely; the other two collapse.
    const byPath = Object.fromEntries((out?.files ?? []).map((f) => [f.path, f.state]));
    expect(byPath).toEqual({ "c.ts": "added", "d.ts": "modified" });
    expect(out?.changedFileCount).toBe(2);
    expect(out?.files.some((f) => f.path === "e.ts")).toBe(false);
  });

  it("counts per state over the projected files", () => {
    const out = toPluginWorktreeStatus(
      makeChanges([
        change("a", "added"),
        change("b", "copied"),
        change("c", "modified"),
        change("d", "deleted"),
        change("e", "renamed"),
        change("f", "untracked"),
        change("g", "ignored"),
      ])
    );
    // copied folds into added → added:2; ignored dropped.
    expect(out?.counts).toEqual({
      added: 2,
      modified: 1,
      deleted: 1,
      untracked: 1,
      renamed: 1,
    });
  });

  it("sorts files by path so the order is stable to diff against", () => {
    const out = toPluginWorktreeStatus(
      makeChanges([
        change("z.ts", "modified"),
        change("a.ts", "modified"),
        change("m.ts", "modified"),
      ])
    );
    expect(out?.files.map((f) => f.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("deep-freezes the projection, the files array, each file, and the counts", () => {
    const out = toPluginWorktreeStatus(makeChanges([change("a.ts", "modified")]));
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out?.files)).toBe(true);
    expect(Object.isFrozen(out?.files[0])).toBe(true);
    expect(Object.isFrozen(out?.counts)).toBe(true);
  });

  it("populates the snapshot's status field from worktreeChanges", () => {
    const out = toPluginWorktreeSnapshot(
      makeSnapshot({
        worktreeChanges: makeChanges([change("src/x.ts", "added")]),
      })
    );
    expect(out.status?.changedFileCount).toBe(1);
    expect(out.status?.files[0]).toEqual({ path: "src/x.ts", state: "added" });
    expect(Object.isFrozen(out.status)).toBe(true);
  });

  it("yields status: null on the snapshot when no changes were polled", () => {
    expect(toPluginWorktreeSnapshot(makeSnapshot()).status).toBeNull();
  });
});
