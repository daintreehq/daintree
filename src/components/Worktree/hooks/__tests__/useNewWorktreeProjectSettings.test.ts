// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const getSettings = vi.hoisted(() => vi.fn());
const hasResourceConfig = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  projectClient: { getSettings },
  worktreeClient: { hasResourceConfig },
}));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: () => ({ recipes: [{ id: "r" }], loadRecipes: vi.fn() }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ currentProject: PROJECT }),
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

const PROJECT = { id: "p1", path: "/repo" };

import { useNewWorktreeProjectSettings } from "../useNewWorktreeProjectSettings";

describe("useNewWorktreeProjectSettings — environments (#17358)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists Project settings' environments while it has some", async () => {
    getSettings.mockResolvedValue({ resourceEnvironments: { cloud: { status: "s" } } });
    hasResourceConfig.mockResolvedValue({ hasConfig: true, environmentKeys: ["home"] });

    const { result } = renderHook(() => useNewWorktreeProjectSettings({ isOpen: true }));

    await waitFor(() => expect(result.current.projectSettings).not.toBeNull());
    await waitFor(() => expect(hasResourceConfig).toHaveBeenCalledWith("/repo"));
    expect(Object.keys(result.current.resourceEnvironments ?? {})).toEqual(["cloud"]);
  });

  it("lists the host's settings-file environments when Project settings has none", async () => {
    getSettings.mockResolvedValue({ resourceEnvironments: { local: {} } });
    hasResourceConfig.mockResolvedValue({ hasConfig: true, environmentKeys: ["cloud", "gpu"] });

    const { result } = renderHook(() => useNewWorktreeProjectSettings({ isOpen: true }));

    await waitFor(() =>
      expect(Object.keys(result.current.resourceEnvironments ?? {})).toEqual(["cloud", "gpu"])
    );
    await waitFor(() => expect(result.current.environmentsLoaded).toBe(true));
  });

  it("isn't loaded until the host has answered, or failed to", async () => {
    getSettings.mockResolvedValue({});
    let answer!: (value: unknown) => void;
    hasResourceConfig.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    const { result } = renderHook(() => useNewWorktreeProjectSettings({ isOpen: true }));

    await waitFor(() => expect(result.current.projectSettings).not.toBeNull());
    expect(result.current.environmentsLoaded).toBe(false);
    answer({ hasConfig: false });
    await waitFor(() => expect(result.current.environmentsLoaded).toBe(true));
  });

  it("is loaded when the settings read fails, rather than holding anything for good", async () => {
    getSettings.mockRejectedValue(new Error("settings unreadable"));
    hasResourceConfig.mockResolvedValue({ hasConfig: true, environmentKeys: ["cloud"] });

    const { result } = renderHook(() => useNewWorktreeProjectSettings({ isOpen: true }));

    await waitFor(() => expect(result.current.environmentsLoaded).toBe(true));
    expect(Object.keys(result.current.resourceEnvironments ?? {})).toEqual(["cloud"]);
  });

  it("waits again for the host's answer each time the dialog opens", async () => {
    getSettings.mockResolvedValue({});
    hasResourceConfig.mockResolvedValue({ hasConfig: false });
    const { result, rerender } = renderHook(
      ({ isOpen }) => useNewWorktreeProjectSettings({ isOpen }),
      { initialProps: { isOpen: true } }
    );
    await waitFor(() => expect(result.current.environmentsLoaded).toBe(true));

    rerender({ isOpen: false });
    expect(result.current.environmentsLoaded).toBe(false);
    let answer!: (value: unknown) => void;
    hasResourceConfig.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    rerender({ isOpen: true });
    await waitFor(() => expect(result.current.projectSettings).not.toBeNull());
    expect(result.current.environmentsLoaded).toBe(false);

    answer({ hasConfig: false });
    await waitFor(() => expect(result.current.environmentsLoaded).toBe(true));
  });

  it("keeps Project settings' own answer from a host that doesn't list its environments", async () => {
    getSettings.mockResolvedValue({});
    hasResourceConfig.mockResolvedValue({ hasConfig: false });

    const { result } = renderHook(() => useNewWorktreeProjectSettings({ isOpen: true }));

    await waitFor(() => expect(result.current.projectSettings).not.toBeNull());
    await waitFor(() => expect(hasResourceConfig).toHaveBeenCalled());
    expect(result.current.resourceEnvironments).toBeUndefined();
  });

  it("asks the host nothing while the dialog is closed", () => {
    renderHook(() => useNewWorktreeProjectSettings({ isOpen: false }));

    expect(hasResourceConfig).not.toHaveBeenCalled();
  });
});
