import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PendingHelpHibernationStore } from "../PendingHelpHibernationStore.js";

describe("PendingHelpHibernationStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pending-hib-"));
    filePath = path.join(tmpDir, "pending.json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a missing project before any set call", async () => {
    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    expect(store.get("proj-1")).toBeNull();
  });

  it("set writes the entry to disk and round-trips through a fresh load", async () => {
    const capturedAt = Date.now();
    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    await store.set("proj-1", {
      agentId: "claude",
      agentSessionId: "agent-resume-id",
      cwd: "/sessions/proj-1",
      capturedAt,
    });

    const fresh = new PendingHelpHibernationStore(filePath);
    await fresh.load();
    expect(fresh.get("proj-1")).toEqual({
      agentId: "claude",
      agentSessionId: "agent-resume-id",
      cwd: "/sessions/proj-1",
      capturedAt,
    });
  });

  it("clear removes the entry from memory and persists the removal", async () => {
    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    await store.set("proj-1", {
      agentId: "claude",
      agentSessionId: "id-a",
      cwd: "/a",
      capturedAt: Date.now(),
    });
    await store.clear("proj-1");

    expect(store.get("proj-1")).toBeNull();

    const fresh = new PendingHelpHibernationStore(filePath);
    await fresh.load();
    expect(fresh.get("proj-1")).toBeNull();
  });

  it("preserves entries for other projects when one is cleared", async () => {
    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    await store.set("proj-A", {
      agentId: "claude",
      agentSessionId: "id-A",
      cwd: "/a",
      capturedAt: Date.now(),
    });
    await store.set("proj-B", {
      agentId: "codex",
      agentSessionId: "id-B",
      cwd: "/b",
      capturedAt: Date.now(),
    });
    await store.clear("proj-A");

    expect(store.get("proj-A")).toBeNull();
    expect(store.get("proj-B")).not.toBeNull();
  });

  it("drops entries older than the staleness cutoff on load", async () => {
    // Stale = older than 14 days. Write a file directly with one stale and
    // one fresh entry, then load and verify only the fresh one survives.
    const stalePast = Date.now() - 15 * 24 * 60 * 60 * 1000;
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "proj-stale": {
            agentId: "claude",
            agentSessionId: "stale-id",
            cwd: "/stale",
            capturedAt: stalePast,
          },
          "proj-fresh": {
            agentId: "claude",
            agentSessionId: "fresh-id",
            cwd: "/fresh",
            capturedAt: Date.now(),
          },
        },
      }),
      "utf-8"
    );

    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    expect(store.get("proj-stale")).toBeNull();
    expect(store.get("proj-fresh")).not.toBeNull();
  });

  it("accepts an empty agentSessionId as the resume-latest sentinel (#9639)", async () => {
    // The empty-sentinel placeholder written before gracefulKill must survive a
    // round-trip through load — dropping it would reintroduce the fresh-launch
    // race after an app restart mid-capture.
    const capturedAt = Date.now();
    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    await store.set("proj-sentinel", {
      agentId: "claude",
      agentSessionId: "",
      cwd: "/sessions/proj-sentinel",
      capturedAt,
    });

    const fresh = new PendingHelpHibernationStore(filePath);
    await fresh.load();
    expect(fresh.get("proj-sentinel")).toEqual({
      agentId: "claude",
      agentSessionId: "",
      cwd: "/sessions/proj-sentinel",
      capturedAt,
    });
  });

  it("still drops a stale empty-sentinel entry past the 14-day cutoff (#9639)", async () => {
    const stalePast = Date.now() - 15 * 24 * 60 * 60 * 1000;
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "proj-stale-sentinel": {
            agentId: "claude",
            agentSessionId: "",
            cwd: "/stale",
            capturedAt: stalePast,
          },
        },
      }),
      "utf-8"
    );

    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    expect(store.get("proj-stale-sentinel")).toBeNull();
  });

  it("rejects entries with a far-future capturedAt (corruption / clock skew)", async () => {
    // A future timestamp would never satisfy the `capturedAt < now - 14d` stale
    // cutoff, pinning a dead resume entry forever — isValid must drop it.
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "proj-future-stamp": {
            agentId: "claude",
            agentSessionId: "future-id",
            cwd: "/future",
            capturedAt: Date.now() + 999_999_999_999,
          },
        },
      }),
      "utf-8"
    );

    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    expect(store.get("proj-future-stamp")).toBeNull();
  });

  it("ignores entries with the wrong shape", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "proj-malformed": { agentId: 42, agentSessionId: "x", cwd: "/x", capturedAt: 1 },
          "proj-ok": {
            agentId: "claude",
            agentSessionId: "ok-id",
            cwd: "/ok",
            capturedAt: Date.now(),
          },
        },
      }),
      "utf-8"
    );

    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    expect(store.get("proj-malformed")).toBeNull();
    expect(store.get("proj-ok")).not.toBeNull();
  });

  it("ignores files written with a future version (forward incompatibility)", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 99,
        entries: {
          "proj-future": {
            agentId: "claude",
            agentSessionId: "f",
            cwd: "/f",
            capturedAt: Date.now(),
          },
        },
      }),
      "utf-8"
    );

    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    expect(store.get("proj-future")).toBeNull();
  });

  it("treats a missing file as an empty store (first launch)", async () => {
    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    expect(store.get("anything")).toBeNull();
  });

  it("never persists the in-memory-only panelWasOpen flag to disk (#10815)", async () => {
    // panelWasOpen drives cold switch-back auto-resume and must stay session-
    // local: if it leaked to disk, a token reloaded on app restart would
    // wrongly auto-reopen + auto-resume a prior session. The in-memory entry
    // keeps the flag; the serialized file must not.
    const capturedAt = Date.now();
    const store = new PendingHelpHibernationStore(filePath);
    await store.load();
    await store.set("proj-1", {
      agentId: "claude",
      agentSessionId: "agent-resume-id",
      cwd: "/sessions/proj-1",
      capturedAt,
      panelWasOpen: true,
    });

    // In-memory read still exposes the flag for the live capture.
    expect(store.get("proj-1")?.panelWasOpen).toBe(true);

    // The serialized JSON must not carry it.
    const raw = await fs.readFile(filePath, "utf-8");
    expect(raw).not.toContain("panelWasOpen");
    const parsed = JSON.parse(raw) as {
      entries: Record<string, Record<string, unknown>>;
    };
    expect(parsed.entries["proj-1"]).not.toHaveProperty("panelWasOpen");

    // A fresh load (simulating an app restart) yields the entry without the
    // flag, so the cold-resume guard reads it as a prior-session token.
    const fresh = new PendingHelpHibernationStore(filePath);
    await fresh.load();
    expect(fresh.get("proj-1")?.panelWasOpen).toBeUndefined();
  });
});
