// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GitHubSettingsTab } from "../GitHubSettingsTab";

vi.mock("@/store", () => ({
  useGitHubConfigStore: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(),
  },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { useGitHubConfigStore } from "@/store";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";

const mockedUseGitHubConfigStore = vi.mocked(useGitHubConfigStore);
const mockedDispatch = vi.mocked(actionService.dispatch);
const mockedNotify = vi.mocked(notify);

function setupStore(overrides: Record<string, unknown> = {}) {
  mockedUseGitHubConfigStore.mockReturnValue({
    config: { hasToken: false, owner: null, repo: null },
    isLoading: false,
    error: null,
    initialize: vi.fn(),
    updateConfig: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useGitHubConfigStore>);
}

describe("GitHubSettingsTab handleSaveToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStore();
  });

  it("dispatches worktree.refresh after a successful token save so the sidebar re-fetches", async () => {
    mockedDispatch.mockImplementation(async (actionId: string) => {
      if (actionId === "github.setToken") {
        return { ok: true, result: { valid: true, scopes: [] } } as never;
      }
      if (actionId === "github.getConfig") {
        return {
          ok: true,
          result: { hasToken: true, owner: null, repo: null },
        } as never;
      }
      if (actionId === "worktree.refresh") {
        return { ok: true, result: undefined } as never;
      }
      return { ok: true, result: undefined } as never;
    });

    render(<GitHubSettingsTab />);

    fireEvent.change(screen.getByLabelText(/github personal access token/i), {
      target: { value: "ghp_valid_token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() => {
      expect(mockedDispatch).toHaveBeenCalledWith(
        "worktree.refresh",
        undefined,
        expect.objectContaining({ source: "user" })
      );
    });

    expect(mockedDispatch).not.toHaveBeenCalledWith(
      "worktree.refreshPullRequests",
      expect.anything(),
      expect.anything()
    );
  });

  it("does not dispatch worktree.refresh when token validation fails", async () => {
    mockedDispatch.mockImplementation(async (actionId: string) => {
      if (actionId === "github.setToken") {
        return {
          ok: true,
          result: { valid: false, scopes: [], error: "Invalid token" },
        } as never;
      }
      return { ok: true, result: undefined } as never;
    });

    render(<GitHubSettingsTab />);

    fireEvent.change(screen.getByLabelText(/github personal access token/i), {
      target: { value: "ghp_invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() => {
      expect(screen.getByText(/invalid token/i)).toBeTruthy();
    });

    expect(mockedDispatch).not.toHaveBeenCalledWith(
      "worktree.refresh",
      expect.anything(),
      expect.anything()
    );
    expect(mockedDispatch).not.toHaveBeenCalledWith(
      "worktree.refreshPullRequests",
      expect.anything(),
      expect.anything()
    );
  });

  it("routes IPC failure to inbox via low-priority notify alongside inline error", async () => {
    mockedDispatch.mockImplementation(async (actionId: string) => {
      if (actionId === "github.setToken") {
        return { ok: false, error: { message: "IPC down" } } as never;
      }
      return { ok: true, result: undefined } as never;
    });

    render(<GitHubSettingsTab />);

    fireEvent.change(screen.getByLabelText(/github personal access token/i), {
      target: { value: "ghp_token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() => {
      expect(mockedNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          priority: "low",
          title: "GitHub token save failed",
        })
      );
    });

    expect(screen.getByText(/failed to save token/i)).toBeTruthy();
  });
});
