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
// (githubConfigStore, project routing) that are out of scope here. The
// GitHub panel is a plugin-contributed slot, so stub the registry hook.
vi.mock("@/registry/builtinRendererRegistry", () => ({
  useBuiltinView: (slotId: string) =>
    slotId === "github.forgeSettingsTab"
      ? function GitHubSettingsStub() {
          return <div data-testid="github-settings-tab" />;
        }
      : null,
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
  credentialFields?: ForgeProviderEntry["contribution"]["credentialFields"],
  slots?: ForgeProviderEntry["contribution"]["slots"]
): ForgeProviderEntry {
  return {
    pluginId,
    contribution: { id, name, matches: ["gitea.example.com"], credentialFields, slots },
  };
}

// The built-in GitHub provider contributes its own settings panel through the
// `slots.settingsTab` builtin-view ref — the host resolves it generically.
function makeGitHubProvider(): ForgeProviderEntry {
  return makeProvider("daintree.github", "github", "GitHub", undefined, {
    settingsTab: "github.forgeSettingsTab",
    icon: "github.providerIcon",
  });
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
    forgeAudit: {
      getRecords: vi.fn(async () => []),
      getConfig: vi.fn(async () => ({ enabled: true, maxRecords: 500 })),
      getStats: vi.fn(async () => ({
        anomalySignals: [],
        anomalySuppressed: true,
        anomalyRecordFloor: 10,
      })),
      clearLog: vi.fn(async () => {}),
      exportLog: vi.fn(async () => false),
      setEnabled: vi.fn(async () => ({ enabled: true, maxRecords: 500 })),
    },
    app: {
      getState: vi.fn(async () => ({ developerMode: { enabled: false } })),
    },
    plugin: {
      onProvenanceChanged: vi.fn(() => () => {}),
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

    render(<CodeForgeSettingsTab activeSubtab="acme.gitea" onSubtabChange={vi.fn()} />);

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

    render(<CodeForgeSettingsTab activeSubtab="acme.gitea" onSubtabChange={vi.fn()} />);

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

    render(<CodeForgeSettingsTab activeSubtab="acme.gitea" onSubtabChange={vi.fn()} />);

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

    render(<CodeForgeSettingsTab activeSubtab="acme.gitea" onSubtabChange={vi.fn()} />);

    const clearButton = await screen.findByRole("button", { name: /clear credentials/i });
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(clearCredential).toHaveBeenCalledWith("acme.gitea");
    });
  });

  it("shows 'No configuration needed' for a provider with no credentialFields", async () => {
    installForgeMocks({
      providers: [makeProvider("acme", "plain", "Plain Forge")],
    });

    render(<CodeForgeSettingsTab activeSubtab="acme.plain" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No configuration needed")).toBeTruthy();
    });
    expect(screen.queryByTestId("forge-credential-form")).toBeNull();
  });

  it("labels a local authless provider instead of 'No configuration needed' (#10563)", async () => {
    const localProvider: ForgeProviderEntry = {
      pluginId: "acme",
      contribution: { id: "mock", name: "Mock Forge", matches: ["mock.local"], kind: "local" },
    };
    installForgeMocks({ providers: [localProvider] });

    render(<CodeForgeSettingsTab activeSubtab="acme.mock" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Local provider — no authentication needed")).toBeTruthy();
    });
    expect(screen.queryByText("No configuration needed")).toBeNull();
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
      <CodeForgeSettingsTab activeSubtab="acme.gitea" onSubtabChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(getCredentialStatus).toHaveBeenCalledWith("acme.gitea");
    });

    rerender(<CodeForgeSettingsTab activeSubtab="acme.gitlab" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(getCredentialStatus).toHaveBeenCalledWith("acme.gitlab");
    });
  });
});

describe("CodeForgeSettingsTab — canonical subtab routing", () => {
  it("routes each provider by canonical id when two plugins share a contribution id", async () => {
    const { getCredentialStatus } = installForgeMocks({
      providers: [
        makeProvider("acme", "forge", "Acme Forge", [
          { id: "token", label: "API token", type: "password" },
        ]),
        makeProvider("globex", "forge", "Globex Forge", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
    });

    const { rerender } = render(
      <CodeForgeSettingsTab activeSubtab="acme.forge" onSubtabChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(getCredentialStatus).toHaveBeenCalledWith("acme.forge");
    });
    expect(screen.getByText("Acme Forge settings")).toBeTruthy();

    rerender(<CodeForgeSettingsTab activeSubtab="globex.forge" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(getCredentialStatus).toHaveBeenCalledWith("globex.forge");
    });
    expect(screen.getByText("Globex Forge settings")).toBeTruthy();
  });

  it("does not route a third-party 'github' contribution to the built-in GitHub card", async () => {
    const { getCredentialStatus } = installForgeMocks({
      providers: [
        makeProvider("acme", "github", "Acme GitHub", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
    });

    render(<CodeForgeSettingsTab activeSubtab="acme.github" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(getCredentialStatus).toHaveBeenCalledWith("acme.github");
    });
    expect(screen.getByTestId("forge-credential-form")).toBeTruthy();
    expect(screen.queryByTestId("github-settings-tab")).toBeNull();
  });

  it("routes the built-in GitHub card and a third-party 'github' contribution independently", async () => {
    const { getCredentialStatus } = installForgeMocks({
      providers: [
        makeGitHubProvider(),
        makeProvider("acme", "github", "Acme GitHub", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
    });

    const { rerender } = render(
      <CodeForgeSettingsTab activeSubtab="daintree.github.github" onSubtabChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("github-settings-tab")).toBeTruthy();
    });
    expect(screen.queryByTestId("forge-credential-form")).toBeNull();

    rerender(<CodeForgeSettingsTab activeSubtab="acme.github" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(getCredentialStatus).toHaveBeenCalledWith("acme.github");
    });
    expect(screen.getByTestId("forge-credential-form")).toBeTruthy();
    expect(screen.queryByTestId("github-settings-tab")).toBeNull();
  });

  it("defaults a fresh open (no subtab) to the first registered provider", async () => {
    installForgeMocks({
      providers: [
        makeGitHubProvider(),
        makeProvider("acme", "gitea", "Gitea", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
    });

    const onSubtabChange = vi.fn();
    render(<CodeForgeSettingsTab activeSubtab={null} onSubtabChange={onSubtabChange} />);

    await waitFor(() => {
      expect(screen.getByTestId("github-settings-tab")).toBeTruthy();
    });
    expect(screen.queryByTestId("forge-credential-form")).toBeNull();
    // The fallback is display-only — the component must not rewrite the
    // caller's subtab state.
    expect(onSubtabChange).not.toHaveBeenCalled();
  });

  it("falls back to General for a stale unrecognized subtab even while providers are registered", async () => {
    installForgeMocks({
      providers: [
        makeGitHubProvider(),
        makeProvider("acme", "gitea", "Gitea", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
    });

    const onSubtabChange = vi.fn();
    render(<CodeForgeSettingsTab activeSubtab="gitea" onSubtabChange={onSubtabChange} />);

    await waitFor(() => {
      expect(screen.getByTestId("forge-integrations-tab")).toBeTruthy();
    });
    expect(screen.queryByTestId("github-settings-tab")).toBeNull();
    expect(onSubtabChange).not.toHaveBeenCalled();
  });

  it("deep-link to the GitHub subtab falls back to General when GitHub is unregistered", async () => {
    // The realistic disabled-plugin dead-end: a stale deep-link (token
    // banner, UpstreamSyncBadge) targets daintree.github.github after the
    // plugin was disabled. The provider list omits GitHub, so the subtab
    // must fall back to General rather than rendering an empty shell.
    installForgeMocks({
      providers: [
        makeProvider("acme", "gitea", "Gitea", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
    });

    render(<CodeForgeSettingsTab activeSubtab="daintree.github.github" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("forge-integrations-tab")).toBeTruthy();
    });
    expect(screen.queryByTestId("github-settings-tab")).toBeNull();
  });

  it("falls back to General for a stale subtab when GitHub is not registered (plugin disabled)", async () => {
    installForgeMocks({
      providers: [
        makeProvider("acme", "gitea", "Gitea", [
          { id: "token", label: "API token", type: "password" },
        ]),
      ],
    });

    const onSubtabChange = vi.fn();
    render(<CodeForgeSettingsTab activeSubtab="gitea" onSubtabChange={onSubtabChange} />);

    // With the GitHub plugin disabled its provider is absent, so defaulting
    // to a GitHub settings panel would resurrect the "disable does nothing"
    // bug — General is the only subtab guaranteed to exist.
    await waitFor(() => {
      expect(screen.getByTestId("forge-integrations-tab")).toBeTruthy();
    });
    expect(screen.queryByTestId("github-settings-tab")).toBeNull();
    expect(onSubtabChange).not.toHaveBeenCalled();
  });
});
