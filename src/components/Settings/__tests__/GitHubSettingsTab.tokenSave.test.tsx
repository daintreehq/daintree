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

import { useGitHubConfigStore } from "@/store";
import { actionService } from "@/services/ActionService";

const mockedUseGitHubConfigStore = vi.mocked(useGitHubConfigStore);
const mockedDispatch = vi.mocked(actionService.dispatch);

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
        return { ok: true, result: { valid: true } } as never;
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
          result: { valid: false, error: "Invalid token" },
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
});
