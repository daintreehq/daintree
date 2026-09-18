// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { GitHubSettingsTab } from "../components/GitHubSettingsTab";
import { SettingsValidationProvider } from "@/components/Settings/SettingsValidationRegistry";

vi.mock("../stores/githubConfigStore", () => ({
  useGitHubConfigStore: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true, result: undefined })) },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

// The dialog primitive has its own suite; a stub keeps this one about the
// tab's import flow rather than overlay plumbing.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    isOpen: boolean;
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
    confirmLabel: string;
    onConfirm: () => void;
    onClose?: () => void;
    isConfirmLoading?: boolean;
  }) =>
    props.isOpen ? (
      <div role="dialog">
        <h2>{props.title}</h2>
        <p>{props.description}</p>
        {props.children}
        <button type="button" onClick={() => props.onConfirm()} disabled={props.isConfirmLoading}>
          {props.confirmLabel}
        </button>
        {props.onClose && (
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
        )}
      </div>
    ) : null,
}));

import { useGitHubConfigStore } from "../stores/githubConfigStore";
import { actionService } from "@/services/ActionService";

const PROVIDER_ID = "daintree.github.github";
const GH_SPEC = {
  tool: "gh",
  label: "GitHub CLI",
  versionArgs: ["--version"],
  severity: "warn",
};

const mockedUseGitHubConfigStore = vi.mocked(useGitHubConfigStore);
const mockedDispatch = vi.mocked(actionService.dispatch);

const forgeMock = {
  setCredential: vi.fn(),
  clearCredential: vi.fn(async () => {}),
  previewCredentialImport: vi.fn(),
  commitCredentialImport: vi.fn(),
};
const systemMock = {
  getHealthCheckSpecs: vi.fn(),
  checkTool: vi.fn(),
};
const updateConfig = vi.fn();

function setupStore(config: Record<string, unknown> = { hasToken: false }) {
  mockedUseGitHubConfigStore.mockReturnValue({
    config,
    isLoading: false,
    error: null,
    initialize: vi.fn(),
    refresh: vi.fn(),
    updateConfig,
  } as unknown as ReturnType<typeof useGitHubConfigStore>);
}

function ghDetected(available: boolean) {
  systemMock.getHealthCheckSpecs.mockResolvedValue([
    { tool: "git", label: "Git", versionArgs: ["--version"], severity: "fatal" },
    GH_SPEC,
  ]);
  systemMock.checkTool.mockResolvedValue({ tool: "gh", label: "GitHub CLI", available });
}

function renderTab() {
  return render(
    <SettingsValidationProvider>
      <GitHubSettingsTab />
    </SettingsValidationProvider>
  );
}

const importButton = () => screen.findByRole("button", { name: "Import from GitHub CLI" });

async function openPreview(preview: Record<string, unknown>) {
  forgeMock.previewCredentialImport.mockResolvedValue(preview);
  renderTab();
  fireEvent.click(await importButton());
}

beforeEach(() => {
  vi.clearAllMocks();
  window.electron = {
    forge: forgeMock,
    system: systemMock,
  } as unknown as typeof window.electron;
  setupStore();
  ghDetected(true);
});

describe("GitHubSettingsTab — import from GitHub CLI", () => {
  it("offers the import only when gh is detected", async () => {
    ghDetected(false);
    renderTab();
    await waitFor(() => expect(systemMock.checkTool).toHaveBeenCalledWith(GH_SPEC));
    expect(screen.queryByRole("button", { name: "Import from GitHub CLI" })).toBeNull();
    expect(screen.getByText("Create a new token")).toBeTruthy();
  });

  it("detects gh from the baseline prerequisites only", async () => {
    renderTab();
    await importButton();
    expect(systemMock.getHealthCheckSpecs).toHaveBeenCalledWith([]);
  });

  it("stays hidden when detection fails", async () => {
    systemMock.getHealthCheckSpecs.mockRejectedValue(new Error("ipc down"));
    renderTab();
    await waitFor(() => expect(systemMock.getHealthCheckSpecs).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Import from GitHub CLI" })).toBeNull();
  });

  it("never reads gh's token on mount", async () => {
    renderTab();
    await importButton();
    expect(forgeMock.previewCredentialImport).not.toHaveBeenCalled();
    expect(screen.getByText("Get a token")).toBeTruthy();
  });

  it("previews on click and shows the account, scopes and what's missing", async () => {
    await openPreview({
      unavailable: false,
      account: "octocat",
      scopes: ["repo", "gist", "workflow"],
      missingScopes: ["read:org"],
      source: "gh",
    });

    expect(forgeMock.previewCredentialImport).toHaveBeenCalledWith(PROVIDER_ID);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Import token for @octocat?");
    expect(dialog.textContent).toContain("plain text");
    expect(dialog.textContent).toContain("including ones Daintree doesn't use:");
    expect(dialog.textContent).toMatch(/Missing\s*read:org/);
    expect(dialog.textContent).not.toContain("replaces the token");
  });

  it("says scopes are unknown rather than missing when GitHub reported none", async () => {
    await openPreview({
      unavailable: false,
      account: "octocat",
      scopes: [],
      missingScopes: [],
      source: "gh",
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("didn't report scopes");
    expect(dialog.textContent).not.toContain("Missing");
  });

  it("warns that a saved token will be replaced", async () => {
    setupStore({ hasToken: true });
    await openPreview({
      unavailable: false,
      account: "octocat",
      scopes: ["repo", "read:org"],
      missingScopes: [],
      source: "gh",
    });
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "This replaces the token you saved earlier."
    );
  });

  it("saves nothing when the confirm is cancelled", async () => {
    await openPreview({
      unavailable: false,
      account: "octocat",
      scopes: ["repo", "read:org"],
      missingScopes: [],
      source: "gh",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(forgeMock.commitCredentialImport).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("commits the confirmed account and shows who is connected", async () => {
    forgeMock.commitCredentialImport.mockResolvedValue({
      unavailable: false,
      account: "octocat",
      scopes: ["repo", "read:org"],
    });
    await openPreview({
      unavailable: false,
      account: "octocat",
      scopes: ["repo", "read:org"],
      missingScopes: [],
      source: "gh",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Import token" }));

    await waitFor(() =>
      expect(forgeMock.commitCredentialImport).toHaveBeenCalledWith(PROVIDER_ID, {
        account: "octocat",
      })
    );
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        hasToken: true,
        username: "octocat",
        scopes: ["repo", "read:org"],
      })
    );
    expect(mockedDispatch).toHaveBeenCalledWith(
      "worktree.refresh",
      undefined,
      expect.objectContaining({ source: "user" })
    );
    expect(await screen.findByText("Token saved")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the fix for a gh that isn't signed in, without opening the confirm", async () => {
    await openPreview({ unavailable: true, reason: "not-signed-in" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Run gh auth login");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for a fresh preview when gh switched accounts before the commit", async () => {
    forgeMock.commitCredentialImport.mockResolvedValue({
      unavailable: true,
      reason: "account-changed",
    });
    await openPreview({
      unavailable: false,
      account: "octocat",
      scopes: ["repo", "read:org"],
      missingScopes: [],
      source: "gh",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Import token" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Import again to review the new account");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("reports a rejected preview call without crashing", async () => {
    forgeMock.previewCredentialImport.mockRejectedValue(new Error("Rate limit exceeded"));
    renderTab();
    fireEvent.click(await importButton());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't read the GitHub CLI token."
    );
  });
});

describe("GitHubSettingsTab — connected account", () => {
  it("names the connected account when one is known", async () => {
    setupStore({ hasToken: true, username: "octocat" });
    renderTab();
    expect(await screen.findByText("GitHub connected as @octocat")).toBeTruthy();
  });

  it("keeps the plain label when the account is unknown", async () => {
    setupStore({ hasToken: true });
    renderTab();
    expect(await screen.findByText("GitHub connected")).toBeTruthy();
  });

  it("records the account a pasted token validated as", async () => {
    forgeMock.setCredential.mockResolvedValue({ valid: true, scopes: [], account: "octocat" });
    renderTab();
    fireEvent.change(screen.getByLabelText(/github personal access token/i), {
      target: { value: "ghp_valid_token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ hasToken: true, username: "octocat" })
    );
  });
});
