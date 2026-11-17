// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/types";

const { projectClientMock } = vi.hoisted(() => ({
  projectClientMock: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    update: vi.fn(),
    checkMissing: vi.fn(),
    onSwitch: vi.fn(() => () => {}),
    onWorktreeLoadStatus: vi.fn(() => () => {}),
  },
}));

// Both exports: projectStore imports worktreeClient too, and a partial module
// mock would leave that one undefined at call time rather than failing loudly.
vi.mock("@/clients", () => ({
  projectClient: projectClientMock,
  worktreeClient: { retryProjectLoad: vi.fn() },
}));
vi.mock("../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    cancel: vi.fn(),
    flush: vi.fn(),
    whenIdle: vi.fn(() => Promise.resolve()),
  },
  panelToSnapshot: vi.fn(),
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/errorContext", () => ({ logErrorWithContext: vi.fn() }));

import { useProjectStore } from "../projectStore";

function makeProject(id: string, name: string): Project {
  return { id, name, path: `/repo/${id}`, emoji: "🌲", lastOpened: 1 };
}

const A = makeProject("a", "Alpha");
const B = makeProject("b", "Bravo");
const C = makeProject("c", "Charlie");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Main's copy of the project list: a write that resolves lands here, so the
 * store's post-success reload reads back what was actually saved.
 */
let server: Map<string, Project>;

/** Queues `projectClient.update` calls so a test settles each one by hand. */
function holdUpdates() {
  const calls: Array<{
    id: string;
    updates: Partial<Project>;
    resolve: () => void;
    reject: (reason: unknown) => void;
  }> = [];
  projectClientMock.update.mockImplementation((id: string, updates: Partial<Project>) => {
    const d = deferred<Project>();
    calls.push({
      id,
      updates,
      resolve: () => {
        const saved = { ...server.get(id)!, ...updates };
        server.set(id, saved);
        d.resolve(saved);
      },
      reject: (reason) => d.reject(reason),
    });
    return d.promise;
  });
  return calls;
}

function project(id: string) {
  return useProjectStore.getState().projects.find((p) => p.id === id);
}

/** A rolled-back write still hands its own error to the caller. */
async function failed(promise: Promise<unknown>) {
  await expect(promise).rejects.toThrow("nope");
}

describe("projectStore.updateProject rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    server = new Map([A, B, C].map((p) => [p.id, { ...p }]));
    projectClientMock.getAll.mockImplementation(async () => [...server.values()]);
    projectClientMock.checkMissing.mockResolvedValue(undefined);
    useProjectStore.setState({
      projects: [A, B, C].map((p) => ({ ...p })),
      currentProject: { ...A },
      isLoading: false,
      error: null,
    });
  });

  it("keeps another project's saved edit when a late write for a different project fails", async () => {
    const calls = holdUpdates();
    useProjectStore.setState({ currentProject: { ...A, lastCompletionSeenAt: 5 } });
    const writeA = useProjectStore.getState().updateProject("a", { name: "Alpha 2", emoji: "🚀" });
    const writeB = useProjectStore.getState().updateProject("b", { name: "Bravo 2", emoji: "🔥" });

    calls[1]!.resolve();
    await writeB;
    expect(project("b")).toMatchObject({ name: "Bravo 2", emoji: "🔥" });

    calls[0]!.reject(new Error("disk full"));
    await expect(writeA).rejects.toThrow("disk full");

    expect(project("a")).toMatchObject({ name: "Alpha", emoji: "🌲" });
    expect(project("b")).toMatchObject({ name: "Bravo 2", emoji: "🔥" });
    expect(useProjectStore.getState().currentProject).toMatchObject({ id: "a", name: "Alpha" });
    expect(useProjectStore.getState().currentProject?.lastCompletionSeenAt).toBe(5);
    expect(useProjectStore.getState().error).toBe("Failed to update project");
  });

  it("rolls back only the failed project's fields when its optimistic value is still showing", async () => {
    const calls = holdUpdates();
    const writeA = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    expect(project("a")?.name).toBe("Alpha 2");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha 2");

    // Main pushes B's saved identity while A's write is still in flight.
    useProjectStore.setState((state) => ({
      projects: state.projects.map((p) => (p.id === "b" ? { ...p, name: "Bravo 2" } : p)),
    }));

    calls[0]!.reject(new Error("nope"));
    await failed(writeA);

    expect(project("a")?.name).toBe("Alpha");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha");
    expect(project("b")?.name).toBe("Bravo 2");
  });

  it("keeps a newer current-project selection made while the write was pending", async () => {
    const calls = holdUpdates();
    const writeA = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    useProjectStore.setState({ currentProject: { ...C } });

    calls[0]!.reject(new Error("nope"));
    await failed(writeA);

    expect(useProjectStore.getState().currentProject).toMatchObject({ id: "c", name: "Charlie" });
    expect(project("a")?.name).toBe("Alpha");
  });

  it.each([true, false])(
    "leaves an unrelated operation's loading flag at %s",
    async (isLoading) => {
      const calls = holdUpdates();
      const writeA = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

      useProjectStore.setState({ isLoading });

      calls[0]!.reject(new Error("nope"));
      await failed(writeA);

      expect(useProjectStore.getState().isLoading).toBe(isLoading);
    }
  );

  it("keeps a still-pending edit to a different field of the same project", async () => {
    const calls = holdUpdates();
    const writeName = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const writeEmoji = useProjectStore.getState().updateProject("a", { emoji: "🚀" });

    calls[0]!.reject(new Error("nope"));
    await failed(writeName);

    expect(project("a")).toMatchObject({ name: "Alpha", emoji: "🚀" });
    expect(useProjectStore.getState().currentProject).toMatchObject({
      name: "Alpha",
      emoji: "🚀",
    });

    calls[1]!.resolve();
    await writeEmoji;
    expect(project("a")).toMatchObject({ name: "Alpha", emoji: "🚀" });
  });

  it("rolls back only the fields a failed write still owns when a newer write took some", async () => {
    const calls = holdUpdates();
    const both = useProjectStore.getState().updateProject("a", { name: "Alpha 2", emoji: "🚀" });
    const emoji = useProjectStore.getState().updateProject("a", { emoji: "🔥" });

    calls[0]!.reject(new Error("nope"));
    await failed(both);

    expect(project("a")).toMatchObject({ name: "Alpha", emoji: "🔥" });
    expect(useProjectStore.getState().currentProject).toMatchObject({
      name: "Alpha",
      emoji: "🔥",
    });

    calls[1]!.reject(new Error("nope"));
    await failed(emoji);
    expect(project("a")).toMatchObject({ name: "Alpha", emoji: "🌲" });
  });

  it("lets a newer edit to the same field win over an older write's failure", async () => {
    const calls = holdUpdates();
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 3" });

    calls[0]!.reject(new Error("nope"));
    await failed(first);
    expect(project("a")?.name).toBe("Alpha 3");

    calls[1]!.resolve();
    await second;
    expect(project("a")?.name).toBe("Alpha 3");
  });

  it("leaves the list untouched when a newer pending write set the same value", async () => {
    const calls = holdUpdates();
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const before = useProjectStore.getState().projects;

    calls[0]!.reject(new Error("nope"));
    await failed(first);
    expect(useProjectStore.getState().projects).toBe(before);
    expect(useProjectStore.getState().currentProject).toEqual(project("a"));
    expect(project("a")?.name).toBe("Alpha 2");

    calls[1]!.reject(new Error("nope"));
    await failed(second);
    expect(project("a")?.name).toBe("Alpha");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha");
  });

  it("restores the saved value when two writes to one field both fail, oldest first", async () => {
    const calls = holdUpdates();
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 3" });

    calls[0]!.reject(new Error("nope"));
    await failed(first);
    calls[1]!.reject(new Error("nope"));
    await failed(second);

    expect(project("a")?.name).toBe("Alpha");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha");
  });

  it("restores the saved value when three writes to one field fail, oldest first", async () => {
    const calls = holdUpdates();
    const writes = ["Alpha 2", "Alpha 3", "Alpha 4"].map((name) =>
      useProjectStore.getState().updateProject("a", { name })
    );

    calls[0]!.reject(new Error("nope"));
    await failed(writes[0]!);
    calls[1]!.reject(new Error("nope"));
    await failed(writes[1]!);
    expect(project("a")?.name).toBe("Alpha 4");

    calls[2]!.reject(new Error("nope"));
    await failed(writes[2]!);
    expect(project("a")?.name).toBe("Alpha");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha");
  });

  it("keeps an older write's saved value when a newer write fails before the reload lands", async () => {
    const calls = holdUpdates();
    const reload = deferred<Project[]>();
    projectClientMock.getAll.mockReturnValueOnce(reload.promise);
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 3" });

    calls[0]!.resolve();
    await vi.waitFor(() => expect(projectClientMock.getAll).toHaveBeenCalled());

    calls[1]!.reject(new Error("nope"));
    await failed(second);
    expect(project("a")?.name).toBe("Alpha 2");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha 2");

    reload.resolve([...server.values()]);
    await first;
    expect(project("a")?.name).toBe("Alpha 2");
  });

  it("hands the field back to a still-pending older write when the newer one fails", async () => {
    const calls = holdUpdates();
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 3" });

    calls[1]!.reject(new Error("nope"));
    await failed(second);
    expect(project("a")?.name).toBe("Alpha 2");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha 2");

    calls[0]!.reject(new Error("nope"));
    await failed(first);
    expect(project("a")?.name).toBe("Alpha");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha");
  });

  it("keeps an equal value Main already saved when an older write for it fails", async () => {
    const calls = holdUpdates();
    useProjectStore.setState({ currentProject: { ...C } });
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    const optimistic = project("a");

    calls[1]!.resolve();
    await second;
    expect(project("a")).not.toBe(optimistic);

    calls[0]!.reject(new Error("nope"));
    await failed(first);
    expect(project("a")?.name).toBe("Alpha 2");
  });

  it("does not undo a value Main pushed for the same project while the write was pending", async () => {
    const calls = holdUpdates();
    const write = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    // Another window saved the same name; Main's push replaces the row and the
    // current project, as the onUpdated listener does.
    const pushed = { ...A, name: "Alpha 2" };
    useProjectStore.setState((state) => ({
      projects: state.projects.map((p) => (p.id === "a" ? pushed : p)),
      currentProject: pushed,
    }));

    calls[0]!.reject(new Error("nope"));
    await failed(write);
    expect(project("a")).toBe(pushed);
    expect(useProjectStore.getState().currentProject).toBe(pushed);
  });

  it("moves the current project to Main's value when a reload replaced its row mid-write", async () => {
    const calls = holdUpdates();
    const write = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    // Another window renamed A; an unrelated reload brings the list row up to
    // date but leaves currentProject as this write's optimistic copy.
    server.set("a", { ...server.get("a")!, name: "Alpha Saved" });
    await useProjectStore.getState().loadProjects();
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha 2");

    calls[0]!.reject(new Error("nope"));
    await failed(write);
    expect(project("a")?.name).toBe("Alpha Saved");
    expect(useProjectStore.getState().currentProject).toMatchObject({
      id: "a",
      name: "Alpha Saved",
    });
  });

  it("keeps a removed project removed when its write fails", async () => {
    const calls = holdUpdates();
    const write = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    useProjectStore.setState((state) => ({
      projects: state.projects.filter((p) => p.id !== "a"),
      currentProject: null,
    }));
    const before = useProjectStore.getState().projects;

    calls[0]!.reject(new Error("nope"));
    await failed(write);
    expect(useProjectStore.getState().projects).toBe(before);
    expect(useProjectStore.getState().currentProject).toBeNull();
  });

  it("keeps the current project on the list row when an older edit is still pending past a reload", async () => {
    const calls = holdUpdates();
    // Hold the missing-folder check so its follow-up reload can't replace the
    // row again after the second write lands.
    projectClientMock.checkMissing.mockReturnValueOnce(deferred<void>().promise);
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    // The reload brings the list row back to Main's value; currentProject keeps
    // the pending optimistic copy.
    await useProjectStore.getState().loadProjects();
    expect(project("a")?.name).toBe("Alpha");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha 2");

    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 3" });
    calls[1]!.reject(new Error("nope"));
    await failed(second);
    expect(project("a")?.name).toBe("Alpha");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha");

    calls[0]!.resolve();
    await first;
    expect(project("a")?.name).toBe("Alpha 2");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha 2");
  });

  it.each([
    ["older", [0, 1], "Alpha 3"],
    ["newer", [1, 0], "Alpha Saved"],
  ] as const)(
    "lands the current project on Main's value when both writes around a reload fail, %s first",
    async (_order, rejectOrder, afterFirst) => {
      const calls = holdUpdates();
      projectClientMock.checkMissing.mockReturnValueOnce(deferred<void>().promise);
      const writes = [useProjectStore.getState().updateProject("a", { name: "Alpha 2" })];

      server.set("a", { ...server.get("a")!, name: "Alpha Saved" });
      await useProjectStore.getState().loadProjects();
      writes.push(useProjectStore.getState().updateProject("a", { name: "Alpha 3" }));

      const [firstIndex, secondIndex] = rejectOrder;
      calls[firstIndex]!.reject(new Error("nope"));
      await failed(writes[firstIndex]!);
      expect(project("a")?.name).toBe(afterFirst);
      expect(useProjectStore.getState().currentProject?.name).toBe(afterFirst);

      calls[secondIndex]!.reject(new Error("nope"));
      await failed(writes[secondIndex]!);
      expect(project("a")?.name).toBe("Alpha Saved");
      expect(useProjectStore.getState().currentProject?.name).toBe("Alpha Saved");
    }
  );

  it("re-syncs the current project from the list when a write fails after a second reload", async () => {
    const calls = holdUpdates();
    projectClientMock.checkMissing.mockReturnValue(deferred<void>().promise);
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    await useProjectStore.getState().loadProjects();
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 3" });
    calls[1]!.reject(new Error("nope"));
    await failed(second);
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha");

    server.set("a", { ...server.get("a")!, name: "Alpha Saved" });
    await useProjectStore.getState().loadProjects();
    expect(project("a")?.name).toBe("Alpha Saved");

    calls[0]!.reject(new Error("nope"));
    await failed(first);
    expect(project("a")?.name).toBe("Alpha Saved");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha Saved");
  });

  it("restores a value the write explicitly cleared", async () => {
    useProjectStore.setState((state) => ({
      projects: state.projects.map((p) => (p.id === "a" ? { ...p, color: "#00ff00" } : p)),
      currentProject: { ...A, color: "#00ff00" },
    }));
    const calls = holdUpdates();
    const write = useProjectStore.getState().updateProject("a", { color: undefined });
    expect(project("a")).toHaveProperty("color", undefined);

    calls[0]!.reject(new Error("nope"));
    await failed(write);
    expect(project("a")?.color).toBe("#00ff00");
    expect(useProjectStore.getState().currentProject?.color).toBe("#00ff00");
  });

  it("restores a field that was absent before the write", async () => {
    const calls = holdUpdates();
    const write = useProjectStore.getState().updateProject("a", { color: "#ff0000" });
    expect(project("a")?.color).toBe("#ff0000");

    calls[0]!.reject(new Error("nope"));
    await failed(write);

    expect(project("a")).not.toHaveProperty("color");
    expect(useProjectStore.getState().currentProject).not.toHaveProperty("color");
  });
});
