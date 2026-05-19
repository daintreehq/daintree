import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const errorStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const notificationHistoryMock = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock("@/store/errorStore", () => ({
  useErrorStore: { getState: errorStoreMock.getState },
}));
vi.mock("@/store/slices/notificationHistorySlice", () => ({
  useNotificationHistoryStore: { getState: notificationHistoryMock.getState },
}));
vi.mock("@/clients", () => ({
  errorsClient: { openLogs: vi.fn() },
  eventInspectorClient: {},
  logsClient: {},
  telemetryPreviewClient: {},
}));

import { registerLogActions } from "../logActions";

function setupActions(): ActionRegistry {
  const actions: ActionRegistry = new Map();
  registerLogActions(actions, {} as ActionCallbacks);
  return actions;
}

function getDef(actions: ActionRegistry, id: string): AnyActionDefinition {
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

async function run(actions: ActionRegistry, id: string, args?: unknown): Promise<any> {
  return getDef(actions, id).run(args, {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("errors.recent", () => {
  it("has safe query metadata in the errors category", () => {
    const def = getDef(setupActions(), "errors.recent");
    expect(def.id).toBe("errors.recent");
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.scope).toBe("renderer");
    expect(def.category).toBe("errors");
    expect(def.description.length).toBeLessThanOrEqual(120);
  });

  it("returns only active (non-dismissed) errors by default", async () => {
    errorStoreMock.getState.mockReturnValue({
      errors: [
        { id: "e1", type: "git", message: "boom", timestamp: 2, dismissed: false },
        { id: "e2", type: "git", message: "old", timestamp: 1, dismissed: true },
      ],
    });
    const result = await run(setupActions(), "errors.recent");
    expect(result.errors.map((e: any) => e.id)).toEqual(["e1"]);
  });

  it("includes dismissed errors when includesDismissed is true", async () => {
    errorStoreMock.getState.mockReturnValue({
      errors: [
        { id: "e1", type: "git", message: "boom", timestamp: 2, dismissed: false },
        { id: "e2", type: "git", message: "old", timestamp: 1, dismissed: true },
      ],
    });
    const result = await run(setupActions(), "errors.recent", { includesDismissed: true });
    expect(result.errors.map((e: any) => e.id)).toEqual(["e1", "e2"]);
  });

  it("respects the limit and preserves newest-first store order", async () => {
    errorStoreMock.getState.mockReturnValue({
      errors: [
        { id: "e1", type: "git", message: "a", timestamp: 3, dismissed: false },
        { id: "e2", type: "git", message: "b", timestamp: 2, dismissed: false },
        { id: "e3", type: "git", message: "c", timestamp: 1, dismissed: false },
      ],
    });
    const result = await run(setupActions(), "errors.recent", { limit: 2 });
    expect(result.errors.map((e: any) => e.id)).toEqual(["e1", "e2"]);
  });

  it("projects only allowed fields and flattens context", async () => {
    errorStoreMock.getState.mockReturnValue({
      errors: [
        {
          id: "e1",
          type: "git",
          message: "boom",
          details: "stack",
          source: "pty",
          timestamp: 5,
          retryability: "auto",
          dismissed: false,
          recoveryHint: "retry",
          retryExhausted: true,
          occurrenceCount: 3,
          context: { worktreeId: "wt1", terminalId: "t1", command: "secret" },
          retryAction: "terminal.restart",
          retryArgs: { a: 1 },
          correlationId: "c1",
          promotedToDock: true,
        },
      ],
    });
    const {
      errors: [r],
    } = await run(setupActions(), "errors.recent");
    expect(r).toEqual({
      id: "e1",
      type: "git",
      message: "boom",
      details: "stack",
      source: "pty",
      timestamp: 5,
      retryability: "auto",
      dismissed: false,
      worktreeId: "wt1",
      terminalId: "t1",
      recoveryHint: "retry",
      retryExhausted: true,
      occurrenceCount: 3,
    });
    expect(r).not.toHaveProperty("retryAction");
    expect(r).not.toHaveProperty("correlationId");
    expect(r).not.toHaveProperty("promotedToDock");
  });

  it("returns an empty array when the store is empty", async () => {
    errorStoreMock.getState.mockReturnValue({ errors: [] });
    expect(await run(setupActions(), "errors.recent")).toEqual({ errors: [] });
  });

  it("sorts by timestamp desc even when store array order is stale (in-place dedup)", async () => {
    errorStoreMock.getState.mockReturnValue({
      errors: [
        { id: "e-old", type: "git", message: "a", timestamp: 1, dismissed: false },
        { id: "e-deduped", type: "git", message: "b", timestamp: 9, dismissed: false },
        { id: "e-mid", type: "git", message: "c", timestamp: 5, dismissed: false },
      ],
    });
    const result = await run(setupActions(), "errors.recent");
    expect(result.errors.map((e: any) => e.id)).toEqual(["e-deduped", "e-mid", "e-old"]);
  });

  it("defaults to a limit of 20", async () => {
    errorStoreMock.getState.mockReturnValue({
      errors: Array.from({ length: 21 }, (_, i) => ({
        id: `e${i}`,
        type: "git",
        message: "x",
        timestamp: 100 - i,
        dismissed: false,
      })),
    });
    const result = await run(setupActions(), "errors.recent");
    expect(result.errors).toHaveLength(20);
  });
});

describe("notifications.recent", () => {
  it("has safe query metadata in the diagnostics category", () => {
    const def = getDef(setupActions(), "notifications.recent");
    expect(def.id).toBe("notifications.recent");
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.scope).toBe("renderer");
    expect(def.category).toBe("diagnostics");
    expect(def.description.length).toBeLessThanOrEqual(120);
  });

  it("returns projected entries newest-first respecting the limit", async () => {
    notificationHistoryMock.getState.mockReturnValue({
      entries: [
        {
          id: "n1",
          type: "success",
          title: "Done",
          message: "ok",
          timestamp: 3,
          seenAsToast: true,
        },
        { id: "n2", type: "info", message: "fyi", timestamp: 2, seenAsToast: false },
        { id: "n3", type: "error", message: "bad", timestamp: 1, seenAsToast: false },
      ],
    });
    const result = await run(setupActions(), "notifications.recent", { limit: 2 });
    expect(result.notifications.map((e: any) => e.id)).toEqual(["n1", "n2"]);
  });

  it("filters by type", async () => {
    notificationHistoryMock.getState.mockReturnValue({
      entries: [
        { id: "n1", type: "success", message: "ok", timestamp: 2, seenAsToast: true },
        { id: "n2", type: "error", message: "bad", timestamp: 1, seenAsToast: false },
      ],
    });
    const result = await run(setupActions(), "notifications.recent", { type: "error" });
    expect(result.notifications.map((e: any) => e.id)).toEqual(["n2"]);
  });

  it("filters to unread only when unreadOnly is true", async () => {
    notificationHistoryMock.getState.mockReturnValue({
      entries: [
        { id: "n1", type: "info", message: "seen", timestamp: 2, seenAsToast: true },
        { id: "n2", type: "info", message: "unseen", timestamp: 1, seenAsToast: false },
      ],
    });
    const result = await run(setupActions(), "notifications.recent", { unreadOnly: true });
    expect(result.notifications.map((e: any) => e.id)).toEqual(["n2"]);
  });

  it("coerces non-string message to a placeholder", async () => {
    notificationHistoryMock.getState.mockReturnValue({
      entries: [
        {
          id: "n1",
          type: "info",
          message: { $$typeof: Symbol.for("react.element") } as unknown as string,
          timestamp: 1,
          seenAsToast: false,
        },
      ],
    });
    const {
      notifications: [r],
    } = await run(setupActions(), "notifications.recent");
    expect(r.message).toBe("[rich content]");
  });

  it("projects only allowed fields and flattens context", async () => {
    notificationHistoryMock.getState.mockReturnValue({
      entries: [
        {
          id: "n1",
          type: "info",
          title: "Hello",
          message: "world",
          timestamp: 7,
          seenAsToast: false,
          summarized: true,
          countable: true,
          correlationId: "c1",
          context: { projectId: "p1", worktreeId: "wt1", panelId: "pn1", eventKind: "completed" },
          actions: [{ label: "Go", actionId: "noop" }],
        },
      ],
    });
    const {
      notifications: [r],
    } = await run(setupActions(), "notifications.recent");
    expect(r).toEqual({
      id: "n1",
      type: "info",
      title: "Hello",
      message: "world",
      timestamp: 7,
      seenAsToast: false,
      worktreeId: "wt1",
      panelId: "pn1",
      eventKind: "completed",
    });
    expect(r).not.toHaveProperty("actions");
    expect(r).not.toHaveProperty("correlationId");
    expect(r).not.toHaveProperty("summarized");
  });

  it("returns an empty array when the inbox is empty", async () => {
    notificationHistoryMock.getState.mockReturnValue({ entries: [] });
    expect(await run(setupActions(), "notifications.recent")).toEqual({ notifications: [] });
  });

  it("excludes non-countable entries from unreadOnly (matches bell-badge semantics)", async () => {
    notificationHistoryMock.getState.mockReturnValue({
      entries: [
        { id: "n1", type: "info", message: "badged", timestamp: 3, seenAsToast: false },
        {
          id: "n2",
          type: "info",
          message: "silent",
          timestamp: 2,
          seenAsToast: false,
          countable: false,
        },
        {
          id: "n3",
          type: "info",
          message: "countable-true",
          timestamp: 1,
          seenAsToast: false,
          countable: true,
        },
      ],
    });
    const result = await run(setupActions(), "notifications.recent", { unreadOnly: true });
    expect(result.notifications.map((e: any) => e.id)).toEqual(["n1", "n3"]);
  });

  it("defaults to a limit of 20", async () => {
    notificationHistoryMock.getState.mockReturnValue({
      entries: Array.from({ length: 21 }, (_, i) => ({
        id: `n${i}`,
        type: "info",
        message: "x",
        timestamp: 100 - i,
        seenAsToast: false,
      })),
    });
    const result = await run(setupActions(), "notifications.recent");
    expect(result.notifications).toHaveLength(20);
  });

  it("applies type, unreadOnly and limit together", async () => {
    notificationHistoryMock.getState.mockReturnValue({
      entries: [
        { id: "n1", type: "error", message: "seen-err", timestamp: 4, seenAsToast: true },
        { id: "n2", type: "error", message: "unseen-err-a", timestamp: 3, seenAsToast: false },
        { id: "n3", type: "info", message: "unseen-info", timestamp: 2, seenAsToast: false },
        { id: "n4", type: "error", message: "unseen-err-b", timestamp: 1, seenAsToast: false },
      ],
    });
    const result = await run(setupActions(), "notifications.recent", {
      type: "error",
      unreadOnly: true,
      limit: 1,
    });
    expect(result.notifications.map((e: any) => e.id)).toEqual(["n2"]);
  });
});
