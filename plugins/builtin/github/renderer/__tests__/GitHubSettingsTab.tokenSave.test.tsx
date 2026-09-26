// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { GitHubSettingsTab } from "../components/GitHubSettingsTab";
import { SettingsValidationProvider } from "@/components/Settings/SettingsValidationRegistry";

vi.mock("../stores/githubConfigStore", () => ({
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

import { useGitHubConfigStore } from "../stores/githubConfigStore";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";

const mockedUseGitHubConfigStore = vi.mocked(useGitHubConfigStore);
const mockedDispatch = vi.mocked(actionService.dispatch);
const mockedNotify = vi.mocked(notify);

const setCredentialMock = vi.fn();
const clearCredentialMock = vi.fn(async () => {});

// Errors render on the token field and again in a visually hidden copy inside
// the actions live region, so the text appears twice by design. Assert the
// visible field error and that the input is flagged invalid.
function expectTokenFieldError(text: RegExp) {
  const matches = screen.getAllByText(text);
  expect(matches.length).toBeGreaterThanOrEqual(1);
  expect(matches.some((el) => !el.classList.contains("sr-only"))).toBe(true);
  expect(screen.getByLabelText(/github personal access token/i).getAttribute("aria-invalid")).toBe(
    "true"
  );
}

function installForgeMocks() {
  window.electron = {
    forge: {
      setCredential: setCredentialMock,
      clearCredential: clearCredentialMock,
    },
  } as unknown as typeof window.electron;
}

function setupStore(overrides: Record<string, unknown> = {}) {
  mockedUseGitHubConfigStore.mockReturnValue({
    config: { hasToken: false },
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
    installForgeMocks();
    setupStore();
  });

  it("saves via forge.setCredential keyed by the canonical GitHub provider id", async () => {
    setCredentialMock.mockResolvedValue({ valid: true, scopes: [] });
    mockedDispatch.mockImplementation(async () => {
      return { ok: true, result: undefined } as never;
    });

    render(
      <SettingsValidationProvider>
        <GitHubSettingsTab />
      </SettingsValidationProvider>
    );

    fireEvent.change(screen.getByLabelText(/github personal access token/i), {
      target: { value: "  ghp_valid_token  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() => {
      expect(setCredentialMock).toHaveBeenCalledWith("daintree.github.github", {
        token: "ghp_valid_token",
      });
    });
  });

  it("dispatches worktree.refresh after a successful token save so the sidebar re-fetches", async () => {
    setCredentialMock.mockResolvedValue({ valid: true, scopes: [] });
    mockedDispatch.mockImplementation(async () => {
      return { ok: true, result: undefined } as never;
    });

    render(
      <SettingsValidationProvider>
        <GitHubSettingsTab />
      </SettingsValidationProvider>
    );

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
    setCredentialMock.mockResolvedValue({ valid: false, scopes: [], error: "Invalid token" });
    mockedDispatch.mockImplementation(async () => {
      return { ok: true, result: undefined } as never;
    });

    render(
      <SettingsValidationProvider>
        <GitHubSettingsTab />
      </SettingsValidationProvider>
    );

    fireEvent.change(screen.getByLabelText(/github personal access token/i), {
      target: { value: "ghp_invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() => {
      expectTokenFieldError(/invalid token/i);
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

  it("shows inline error on IPC failure without firing notify", async () => {
    setCredentialMock.mockRejectedValue(new Error("IPC down"));
    mockedDispatch.mockImplementation(async () => {
      return { ok: true, result: undefined } as never;
    });

    render(
      <SettingsValidationProvider>
        <GitHubSettingsTab />
      </SettingsValidationProvider>
    );

    fireEvent.change(screen.getByLabelText(/github personal access token/i), {
      target: { value: "ghp_token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() => {
      expectTokenFieldError(/couldn't save token/i);
    });

    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("clears via forge.clearCredential keyed by the canonical GitHub provider id", async () => {
    setupStore({ config: { hasToken: true } });
    mockedDispatch.mockImplementation(async () => {
      return { ok: true, result: undefined } as never;
    });

    render(
      <SettingsValidationProvider>
        <GitHubSettingsTab />
      </SettingsValidationProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear token" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Clear the GitHub token?")).toBeTruthy();
    expect(clearCredentialMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear token" }));

    await waitFor(() => {
      expect(clearCredentialMock).toHaveBeenCalledWith("daintree.github.github");
    });
  });

  it("shows inline error when token validation IPC fails", async () => {
    mockedDispatch.mockImplementation(async (actionId: string) => {
      if (actionId === "forge.validateToken") {
        return { ok: false, error: { message: "IPC down" } } as never;
      }
      return { ok: true, result: undefined } as never;
    });

    render(
      <SettingsValidationProvider>
        <GitHubSettingsTab />
      </SettingsValidationProvider>
    );

    fireEvent.change(screen.getByLabelText(/github personal access token/i), {
      target: { value: "ghp_token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test token" }));

    await waitFor(() => {
      expectTokenFieldError(/couldn't validate token/i);
    });

    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("Test button dispatches forge.validateToken with the GitHub provider id so a non-GitHub default cannot reroute the call (#9985)", async () => {
    mockedDispatch.mockImplementation(async (actionId: string, args: unknown) => {
      if (actionId === "forge.validateToken") {
        return {
          ok: true,
          result: { valid: true, scopes: ["repo"], error: undefined },
        } as never;
      }
      // Defensive — make the assertion message below specific to the test id
      void args;
      return { ok: true, result: undefined } as never;
    });

    render(
      <SettingsValidationProvider>
        <GitHubSettingsTab />
      </SettingsValidationProvider>
    );

    fireEvent.change(screen.getByLabelText(/github personal access token/i), {
      target: { value: "  ghp_typed_token  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test token" }));

    await waitFor(() => {
      expect(mockedDispatch).toHaveBeenCalledWith(
        "forge.validateToken",
        expect.objectContaining({
          providerId: "daintree.github.github",
          token: "ghp_typed_token",
        }),
        expect.objectContaining({ source: "user" })
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/token works — not saved yet/i)).toBeTruthy();
    });
  });
});

describe("GitHubSettingsTab in a window attached to another host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installForgeMocks();
  });

  const renderTab = () =>
    render(
      <SettingsValidationProvider>
        <GitHubSettingsTab />
      </SettingsValidationProvider>
    );

  it("says GitHub isn't connected on that host, and names it when it is", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    setHostPlatformInfo({ hostName: "studio-01" });
    try {
      setupStore();
      const { unmount } = renderTab();
      expect(screen.getByText("GitHub isn't connected on studio-01")).toBeTruthy();
      unmount();
      setupStore({ config: { hasToken: true, username: "greg" } });
      renderTab();
      expect(screen.getByText("Token saved for @greg on studio-01")).toBeTruthy();
    } finally {
      delete window.__DAINTREE_HOST_ID__;
      _resetHostPlatformForTests();
    }
  });

  it("keeps the local wording in a local window", () => {
    setupStore();
    renderTab();
    expect(screen.getByText("No token saved")).toBeTruthy();
  });
});
