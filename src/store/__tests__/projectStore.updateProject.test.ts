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

async function settle(promise: Promise<unknown>) {
  await promise.then(
    () => undefined,
    () => undefined
  );
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
    await settle(writeA);

    expect(project("a")?.name).toBe("Alpha");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha");
    expect(project("b")?.name).toBe("Bravo 2");
  });

  it("keeps a newer current-project selection made while the write was pending", async () => {
    const calls = holdUpdates();
    const writeA = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    useProjectStore.setState({ currentProject: { ...C } });

    calls[0]!.reject(new Error("nope"));
    await settle(writeA);

    expect(useProjectStore.getState().currentProject).toMatchObject({ id: "c", name: "Charlie" });
    expect(project("a")?.name).toBe("Alpha");
  });

  it("leaves an unrelated operation's loading flag alone", async () => {
    const calls = holdUpdates();
    const writeA = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    useProjectStore.setState({ isLoading: true });

    calls[0]!.reject(new Error("nope"));
    await settle(writeA);

    expect(useProjectStore.getState().isLoading).toBe(true);
  });

  it("keeps a still-pending edit to a different field of the same project", async () => {
    const calls = holdUpdates();
    const writeName = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const writeEmoji = useProjectStore.getState().updateProject("a", { emoji: "🚀" });

    calls[0]!.reject(new Error("nope"));
    await settle(writeName);

    expect(project("a")).toMatchObject({ name: "Alpha", emoji: "🚀" });
    expect(useProjectStore.getState().currentProject).toMatchObject({
      name: "Alpha",
      emoji: "🚀",
    });

    calls[1]!.resolve();
    await writeEmoji;
    expect(project("a")).toMatchObject({ name: "Alpha", emoji: "🚀" });
  });

  it("lets a newer edit to the same field win over an older write's failure", async () => {
    const calls = holdUpdates();
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 3" });

    calls[0]!.reject(new Error("nope"));
    await settle(first);
    expect(project("a")?.name).toBe("Alpha 3");

    calls[1]!.resolve();
    await second;
    expect(project("a")?.name).toBe("Alpha 3");
  });

  it("restores the saved value when two writes to one field both fail, oldest first", async () => {
    const calls = holdUpdates();
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 3" });

    calls[0]!.reject(new Error("nope"));
    await settle(first);
    calls[1]!.reject(new Error("nope"));
    await settle(second);

    expect(project("a")?.name).toBe("Alpha");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha");
  });

  it("hands the field back to a still-pending older write when the newer one fails", async () => {
    const calls = holdUpdates();
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 3" });

    calls[1]!.reject(new Error("nope"));
    await settle(second);
    expect(project("a")?.name).toBe("Alpha 2");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha 2");

    calls[0]!.reject(new Error("nope"));
    await settle(first);
    expect(project("a")?.name).toBe("Alpha");
    expect(useProjectStore.getState().currentProject?.name).toBe("Alpha");
  });

  it("keeps an equal value Main already saved when an older write for it fails", async () => {
    const calls = holdUpdates();
    useProjectStore.setState({ currentProject: { ...C } });
    const first = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });
    const second = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    calls[1]!.resolve();
    await second;

    calls[0]!.reject(new Error("nope"));
    await settle(first);
    expect(project("a")?.name).toBe("Alpha 2");
  });

  it("does not undo a value Main pushed for the same project while the write was pending", async () => {
    const calls = holdUpdates();
    const write = useProjectStore.getState().updateProject("a", { name: "Alpha 2" });

    // Another window saved the same name; Main's push replaces the row.
    useProjectStore.setState((state) => ({
      projects: state.projects.map((p) => (p.id === "a" ? { ...A, name: "Alpha 2" } : p)),
    }));

    calls[0]!.reject(new Error("nope"));
    await settle(write);
    expect(project("a")?.name).toBe("Alpha 2");
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
    await settle(write);
    expect(useProjectStore.getState().projects).toBe(before);
    expect(useProjectStore.getState().currentProject).toBeNull();
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
    await settle(write);
    expect(project("a")?.color).toBe("#00ff00");
    expect(useProjectStore.getState().currentProject?.color).toBe("#00ff00");
  });

  it("restores a field that was absent before the write", async () => {
    const calls = holdUpdates();
    const write = useProjectStore.getState().updateProject("a", { color: "#ff0000" });
    expect(project("a")?.color).toBe("#ff0000");

    calls[0]!.reject(new Error("nope"));
    await settle(write);

    expect(project("a")).not.toHaveProperty("color");
    expect(useProjectStore.getState().currentProject).not.toHaveProperty("color");
  });
});
