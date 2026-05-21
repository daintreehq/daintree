// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { CodeForgeSettingsTab } from "../CodeForgeSettingsTab";
import type { ForgeProviderEntry } from "@shared/types";
import type { AuthValidation } from "@shared/types/forge";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

// Isolate the generic credential form: the sibling tabs pull heavy stores
// (githubConfigStore, project routing) that are out of scope here.
vi.mock("../GitHubSettingsTab", () => ({
  GitHubSettingsTab: () => <div data-testid="github-settings-tab" />,
}));
vi.mock("../ForgeIntegrationsTab", () => ({
  ForgeIntegrationsTab: () => <div data-testid="forge-integrations-tab" />,
}));
vi.mock("../ForgeProviderSelectorDropdown", () => ({
  ForgeProviderSelectorDropdown: () => <div data-testid="forge-provider-selector" />,
}));
vi.mock("../SettingsValidationRegistry", () => ({
  useSettingsTabValidation: vi.fn(),
}));

function makeProvider(
  pluginId: string,
  id: string,
  name: string,
  credentialFields?: ForgeProviderEntry["contribution"]["credentialFields"]
): ForgeProviderEntry {
  return {
    pluginId,
    contribution: { id, name, matches: ["gitea.example.com"], credentialFields },
  };
}

interface ForgeMockOptions {
  providers: ForgeProviderEntry[];
  hasCredential?: boolean;
  setCredentialResult?: AuthValidation;
}

function installForgeMocks(opts: ForgeMockOptions) {
  const setCredential = vi.fn(
    async (): Promise<AuthValidation> => opts.setCredentialResult ?? { valid: true }
  );
  const getCredentialStatus = vi.fn(async () => ({
    hasCredential: opts.hasCredential ?? false,
  }));
  const clearCredential = vi.fn(async () => {});
  window.electron = {
    forge: {
      getProviders: vi.fn(async () => opts.providers),
      setCredential,
      getCredentialStatus,
      clearCredential,
    },
  } as unknown as typeof window.electron;
  return { setCredential, getCredentialStatus, clearCredential };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CodeForgeSettingsTab — generic credential form", () => {
  it("renders a real credential input for a provider that declares credentialFields", async () => {
    installForgeMocks({
      providers: [
        makeProvider("acme", "gitea", "Gitea", [
          { id: "token", label: "API token", type: "password", helpText: "Personal access token" },
        ]),
      ],
    });

    render(<CodeForgeSettingsTab activeSubtab="gitea" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("forge-credential-form")).toBeTruthy();
    });
    const input = screen.getByLabelText("API token") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByText("Personal access token")).toBeTruthy();
    expect(screen.queryByText("No configuration needed")).toBeNull();
  });

  it("validates and persists via forge.setCredential keyed by the canonical provider id", async () => {
    const { setCredential } = installForgeMocks({
      providers: [
        makeProvider("acme", "gitea", "Gitea", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
      setCredentialResult: { valid: true },
    });

    render(<CodeForgeSettingsTab activeSubtab="gitea" onSubtabChange={vi.fn()} />);

    const input = (await screen.findByLabelText("API token")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "secret-token" } });
    const saveButton = screen.getByRole("button", { name: "Save credentials" });
    await waitFor(() => {
      expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(setCredential).toHaveBeenCalledWith("acme.gitea", { token: "secret-token" });
    });
    await waitFor(() => {
      expect(screen.getByText("Credentials saved")).toBeTruthy();
    });
  });

  it("surfaces the validation error and does not clear the field on invalid credentials", async () => {
    const { setCredential } = installForgeMocks({
      providers: [
        makeProvider("acme", "gitea", "Gitea", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
      setCredentialResult: { valid: false, error: "Bad token" },
    });

    render(<CodeForgeSettingsTab activeSubtab="gitea" onSubtabChange={vi.fn()} />);

    const input = (await screen.findByLabelText("API token")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nope" } });
    const saveButton = screen.getByRole("button", { name: "Save credentials" });
    await waitFor(() => {
      expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(setCredential).toHaveBeenCalled();
      expect(screen.getByText("Bad token")).toBeTruthy();
    });
    expect((screen.getByLabelText("API token") as HTMLInputElement).value).toBe("nope");
  });

  it("clears stored credentials via forge.clearCredential when already connected", async () => {
    const { clearCredential } = installForgeMocks({
      providers: [
        makeProvider("acme", "gitea", "Gitea", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
      hasCredential: true,
    });

    render(<CodeForgeSettingsTab activeSubtab="gitea" onSubtabChange={vi.fn()} />);

    const clearButton = await screen.findByRole("button", { name: "Clear" });
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(clearCredential).toHaveBeenCalledWith("acme.gitea");
    });
  });

  it("shows 'No configuration needed' for a provider with no credentialFields", async () => {
    installForgeMocks({
      providers: [makeProvider("acme", "plain", "Plain Forge")],
    });

    render(<CodeForgeSettingsTab activeSubtab="plain" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No configuration needed")).toBeTruthy();
    });
    expect(screen.queryByTestId("forge-credential-form")).toBeNull();
  });

  it("reloads credential status when the selected provider changes", async () => {
    const { getCredentialStatus } = installForgeMocks({
      providers: [
        makeProvider("acme", "gitea", "Gitea", [
          { id: "token", label: "API token", type: "password" },
        ]),
        makeProvider("acme", "gitlab", "GitLab", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
    });

    const { rerender } = render(
      <CodeForgeSettingsTab activeSubtab="gitea" onSubtabChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(getCredentialStatus).toHaveBeenCalledWith("acme.gitea");
    });

    rerender(<CodeForgeSettingsTab activeSubtab="gitlab" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(getCredentialStatus).toHaveBeenCalledWith("acme.gitlab");
    });
  });
});
