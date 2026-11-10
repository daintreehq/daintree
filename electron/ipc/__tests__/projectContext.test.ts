import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, webContents: { fromId: vi.fn() } }));

const projectStoreMock = vi.hoisted(() => ({ getProjectById: vi.fn() }));
vi.mock("../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

import { markProjectlessView } from "../../window/projectlessViews.js";
import { resolveScopedProjectForIpcContext } from "../projectContext.js";
import type { HandlerDependencies, IpcContext } from "../types.js";

const view = { id: 44, once: vi.fn() };

afterEach(() => {
  view.once.mock.calls.find(([event]) => event === "destroyed")?.[1]();
  view.once.mockClear();
});

describe("resolveScopedProjectForIpcContext", () => {
  it("answers no project for a view that holds none, whatever the app-wide manager says", () => {
    markProjectlessView(view as never, {} as never);
    const projectViewManager = { getProjectIdForWebContents: vi.fn(() => "p1") };

    const resolved = resolveScopedProjectForIpcContext(
      { event: { sender: view }, webContentsId: view.id, projectId: "p1" } as unknown as IpcContext,
      { projectViewManager } as unknown as HandlerDependencies
    );

    expect(resolved).toEqual({ project: null, workspaceId: null });
    expect(projectViewManager.getProjectIdForWebContents).not.toHaveBeenCalled();
    expect(projectStoreMock.getProjectById).not.toHaveBeenCalled();
  });
});
