// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { HelpAssistantSettings } from "@shared/types/ipc/api";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

// The icons barrel is imported transitively by ConfirmDialog → AppDialog →
// @/hooks → terminalRunIconRegistry, which references many brand icon names.
// Stub every named export so the test file doesn't need to enumerate them.
vi.mock("@/components/icons", () => {
  const stub = () => null;
  return {
    DaintreeIcon: ({ className }: { className?: string }) => (
      <span data-testid="daintree-icon" className={className} />
    ),
    McpServerIcon: ({ className }: { className?: string }) => (
      <span data-testid="mcp-icon" className={className} />
    ),
    SpinnerCircle: stub,
    HollowCircle: stub,
    InteractingCircle: stub,
    ExitedCircle: stub,
    NpmIcon: stub,
    YarnIcon: stub,
    PnpmIcon: stub,
    BunIcon: stub,
    PythonIcon: stub,
    ComposerIcon: stub,
    DockerIcon: stub,
    RustIcon: stub,
    GoIcon: stub,
    RubyIcon: stub,
    NodeIcon: stub,
    DenoIcon: stub,
    GradleIcon: stub,
    PhpIcon: stub,
    ViteIcon: stub,
    WebpackIcon: stub,
    KotlinIcon: stub,
    SwiftIcon: stub,
    TerraformIcon: stub,
    ElixirIcon: stub,
  };
});

interface SettingsSelectStubOption {
  value: string;
  label: string;
}

/**
 * A complete `HelpAssistantSettings`, as main would return it.
 *
 * Typed rather than a loose object literal so a field added to the interface surfaces
 * here as a compile error. It matters because `persist` now replaces state WHOLESALE
 * from main's answer — a mock missing a field would silently blank it, and the test
 * would be exercising a shape the real handler never produces.
 */
function settingsFixture(): HelpAssistantSettings {
  return {
    docSearch: true,
    daintreeControl: true,
    tier: "action",
    bypassPermissions: false,
    auditRetention: 7,
    customArgs: "",
    modelId: "",
    idleHibernateMinutes: 0,
  };
}

vi.mock("../SettingsSelect", () => ({
  SettingsSelect: ({
    label,
    description,
    value,
    onValueChange,
    options,
    disabled,
  }: {
    label: string;
    description?: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
    options: SettingsSelectStubOption[];
    disabled?: boolean;
  }) => (
    <label>
      {label}
      {description != null && <span>{description}</span>}
      {/* `disabled` is forwarded deliberately: it is part of what the component
          promises, and a stub that drops it makes every lock look untested. */}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  ),
}));

vi.mock("../SettingsInput", () => ({
  SettingsInput: ({
    label,
    value,
    onChange,
    placeholder,
    disabled,
  }: {
    label: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    disabled?: boolean;
  }) => (
    <label>
      {label}
      <input
        aria-label={label}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
      />
    </label>
  ),
}));

const helpPanelState = {
  preferredAgentId: null as string | null,
  droppedPreferredAgentId: null as string | null,
  sessionId: null as string | null,
  setPreferredAgent: vi.fn(),
  clearDroppedPreferredAgent: vi.fn(),
};

vi.mock("@/store/helpPanelStore", () => {
  const store = (selector?: (s: typeof helpPanelState) => unknown) =>
    selector ? selector(helpPanelState) : helpPanelState;
  store.getState = () => helpPanelState;
  return {
    useHelpPanelStore: store,
    // #12108: the live-status card follows the lane on screen. This fixture is
    // flat and single-lane, so the selector projects it as that lane.
    selectActiveSlot: (s: typeof helpPanelState) => s,
    HELP_PANEL_MIN_WIDTH: 320,
    HELP_PANEL_MAX_WIDTH: 800,
    HELP_PANEL_DEFAULT_WIDTH: 380,
  };
});

const { mockGetAssistantSupportedAgentIds } = vi.hoisted(() => ({
  mockGetAssistantSupportedAgentIds: vi.fn<() => string[]>(() => ["claude"]),
}));

vi.mock("@/config/agents", () => ({
  getAgentIds: () => ["claude", "codex"],
  getAssistantSupportedAgentIds: () => mockGetAssistantSupportedAgentIds(),
  // `supports` must be present: the bypass card reads permissionBypass to
  // decide whether the selected agent has a bypass mechanism at all.
  getAgentConfig: (id: string) => {
    if (id === "claude")
      return {
        name: "Claude Code",
        assistantMinVersion: "2.0.0",
        supports: { permissionBypass: true, tier: "stable" },
      };
    if (id === "codex")
      return { name: "Codex", supports: { permissionBypass: true, tier: "stable" } };
    if (id === "daintree-assistant")
      return { name: "Daintree Assistant", supports: { permissionBypass: false, tier: "stable" } };
    // Assistant-wired but with no bypass mechanism of any kind — the shape a
    // user-defined agent takes.
    if (id === "byoa")
      return { name: "BYOA", supports: { permissionBypass: false, tier: "stable" } };
    // Has a DEFAULT_DANGEROUS_ARGS entry (--yolo) but opts out of bypass, so it
    // isolates the permissionBypass clause from the missing-flag clause.
    if (id === "gemini")
      return { name: "Gemini", supports: { permissionBypass: false, tier: "stable" } };
    return undefined;
  },
}));

import {
  DaintreeAssistantSettingsTab,
  formatGrantRemaining,
} from "../DaintreeAssistantSettingsTab";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";

const writeText = vi.fn().mockResolvedValue(undefined);

interface HelpAssistantApi {
  getSettings: ReturnType<typeof vi.fn>;
  setSettings: ReturnType<typeof vi.fn>;
  getLiveSessionStatus: ReturnType<typeof vi.fn>;
}

interface McpServerApi {
  getStatus: ReturnType<typeof vi.fn>;
  getRuntimeState: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  rotateApiKey: ReturnType<typeof vi.fn>;
  getConfigSnippet: ReturnType<typeof vi.fn>;
  onRuntimeStateChanged: ReturnType<typeof vi.fn>;
  onGrantLifecycle: ReturnType<typeof vi.fn>;
  getAuditRecords: ReturnType<typeof vi.fn>;
  getLogRecords: ReturnType<typeof vi.fn>;
  getAuditStats: ReturnType<typeof vi.fn>;
  getTurnOutcomeRecords: ReturnType<typeof vi.fn>;
  getAuditConfig: ReturnType<typeof vi.fn>;
  setAuditEnabled: ReturnType<typeof vi.fn>;
  clearAuditLog: ReturnType<typeof vi.fn>;
}

interface SystemApi {
  getAgentVersion: ReturnType<typeof vi.fn>;
}

function installApi(
  helpAssistant: Partial<HelpAssistantApi> = {},
  mcpServer: Partial<McpServerApi> = {},
  system: Partial<SystemApi> = {}
) {
  const storedSettings = settingsFixture();
  const helpDefaults: HelpAssistantApi = {
    getSettings: vi.fn().mockResolvedValue({ ...storedSettings }),
    // Answers with the settings as they now stand, like the real handler: it reads
    // back rather than echoing the patch, so a caller can tell what actually landed.
    setSettings: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(storedSettings, patch);
      return { ...storedSettings };
    }),
    getLiveSessionStatus: vi
      .fn()
      .mockResolvedValue({ connected: false, tier: "workbench", activeGrants: [] }),
  };
  const mcpDefaults: McpServerApi = {
    getStatus: vi.fn().mockResolvedValue({
      enabled: true,
      port: 45454,
      configuredPort: 45454,
      apiKey: "dnt-key-abc",
    }),
    getRuntimeState: vi.fn().mockResolvedValue({
      enabled: true,
      state: "ready",
      port: 45454,
      lastError: null,
    }),
    setEnabled: vi.fn().mockResolvedValue({
      enabled: true,
      port: 45454,
      configuredPort: 45454,
      apiKey: "dnt-key-abc",
    }),
    rotateApiKey: vi.fn().mockResolvedValue("dnt-key-new"),
    getConfigSnippet: vi.fn().mockResolvedValue('{ "url": "http://127.0.0.1:45454/mcp" }'),
    onRuntimeStateChanged: vi.fn(() => () => {}),
    onGrantLifecycle: vi.fn(() => () => {}),
    getAuditRecords: vi.fn().mockResolvedValue([]),
    getLogRecords: vi.fn().mockResolvedValue([]),
    getAuditStats: vi.fn().mockResolvedValue({ auth401Count: 0 }),
    getTurnOutcomeRecords: vi.fn().mockResolvedValue([]),
    getAuditConfig: vi.fn().mockResolvedValue({ enabled: true, maxRecords: 500 }),
    setAuditEnabled: vi
      .fn()
      .mockImplementation((next: boolean) => Promise.resolve({ enabled: next, maxRecords: 500 })),
    clearAuditLog: vi.fn().mockResolvedValue(undefined),
  };
  const systemDefaults: SystemApi = {
    // Indeterminate by default (no installed version) so the version probe
    // never raises a warning unless a test opts in with a concrete version.
    getAgentVersion: vi.fn().mockResolvedValue({
      agentId: "claude",
      installedVersion: null,
      latestVersion: null,
      updateAvailable: false,
      lastChecked: null,
    }),
  };
  window.electron = {
    helpAssistant: { ...helpDefaults, ...helpAssistant },
    mcpServer: { ...mcpDefaults, ...mcpServer },
    system: { ...systemDefaults, ...system },
    agentCapabilities: {
      // The model picker (PR #10711) resolves the agent's model catalog on
      // mount. Default to none so the picker stays hidden and these tests
      // exercise the pre-picker layout they were written against.
      getResolvedModelList: vi.fn().mockResolvedValue(null),
    },
  } as unknown as typeof window.electron;
}

describe("DaintreeAssistantSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helpPanelState.preferredAgentId = null;
    helpPanelState.droppedPreferredAgentId = null;
    helpPanelState.sessionId = null;
    helpPanelState.setPreferredAgent = vi.fn();
    helpPanelState.clearDroppedPreferredAgent = vi.fn();
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    installApi();
  });

  const waitForContent = (container: HTMLElement, text: string) =>
    waitFor(
      () => {
        expect(container.textContent).toContain(text);
      },
      { timeout: 5000 }
    );

  it("loads settings and MCP status on mount", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Search documentation");

    expect(window.electron.helpAssistant.getSettings).toHaveBeenCalledTimes(1);
    expect(window.electron.mcpServer.getStatus).toHaveBeenCalledTimes(1);
  });

  it("toggling doc search persists docSearch=false", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Search documentation");

    const toggle = screen.getByLabelText("Allow the assistant to search Daintree documentation");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(window.electron.helpAssistant.setSettings).toHaveBeenCalledWith({ docSearch: false });
    });
  });

  it("turning on bypass permissions reveals the inline warning copy", async () => {
    helpPanelState.preferredAgentId = "claude";
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Bypass Claude permission prompts");

    expect(container.textContent).not.toContain("unless an automation grant covers them");

    const toggle = screen.getByLabelText("Bypass Claude permission prompts during help sessions");
    fireEvent.click(toggle);

    await waitForContent(container, "unless an automation grant covers them");
    expect(window.electron.helpAssistant.setSettings).toHaveBeenCalledWith({
      bypassPermissions: true,
    });
  });

  // One stored boolean, three different mechanisms behind it. Labelling them
  // all as Claude's flag reads as a no-op while silently enabling
  // auto-approval, so the copy has to follow the selected agent (#11879).
  it("labels the bypass toggle with the selected agent's own mechanism", async () => {
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex", "daintree-assistant"]);
    helpPanelState.preferredAgentId = "codex";

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Bypass Codex approvals and sandbox");

    expect(container.textContent).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(container.textContent).not.toContain("--dangerously-skip-permissions");
    expect(container.textContent).not.toContain("Bypass Claude permission prompts");

    const toggle = screen.getByLabelText("Bypass Codex approvals and sandbox during help sessions");
    fireEvent.click(toggle);

    // The warning has to name the sandbox: Codex's flag gives up more than a
    // confirmation gate, and understating that is the bug being fixed.
    await waitForContent(container, "outside its sandbox");
    expect(container.textContent).not.toContain("built-in (Bash, Write)");
    // Scoped to Codex's OWN approvals (#12119): an unqualified "without
    // approval" contradicts the host-confirmation exception appended below it.
    expect(container.textContent).toContain("without its own approval prompts");
  });

  it("describes the Daintree Assistant's env-var bypass, not a CLI flag", async () => {
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex", "daintree-assistant"]);
    helpPanelState.preferredAgentId = "daintree-assistant";

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Auto-approve assistant actions");

    expect(container.textContent).toContain("own per-action confirmation sheet");
    // The assistant has no dangerous-args entry, so no flag may be claimed.
    expect(container.textContent).not.toContain("--dangerously");

    const toggle = screen.getByLabelText(
      "Auto-approve Daintree Assistant actions during help sessions"
    );
    fireEvent.click(toggle);

    await waitForContent(container, "acts without asking");
    // Same #12119 scoping: the sheet it skips is its own, not Daintree's host
    // confirmation, which still fires for confirmation-required actions.
    expect(container.textContent).toContain("it skips its own confirmation sheet for everything");
    expect(window.electron.helpAssistant.setSettings).toHaveBeenCalledWith({
      bypassPermissions: true,
    });
  });

  // #11907: with the confirmation sheet off, the tier carries most of the
  // remaining boundary, so the warning has to name it — and keep naming the
  // right one when the selector moves (a missing memo dependency would freeze
  // the old tier in the copy while the selector reads the new one). #12119
  // stopped it claiming to be the *entire* boundary, so the assertions below
  // pin both halves: the tier-named limit and the confirmation exception.
  it("names the configured tier in the auto-approve warning and follows the selector", async () => {
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex", "daintree-assistant"]);
    helpPanelState.preferredAgentId = "daintree-assistant";

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Auto-approve assistant actions");

    // The switch stays disabled until the initial settings and MCP-status loads
    // both settle, and the heading above renders before that — clicking while
    // it's still disabled would drop the event and time out downstream.
    const toggle = screen.getByLabelText(
      "Auto-approve Daintree Assistant actions during help sessions"
    );
    await waitFor(() => {
      expect(toggle.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(toggle);

    await waitForContent(
      container,
      "New sessions are limited to the Daintree actions the Action capability tier allows"
    );

    fireEvent.change(screen.getByLabelText("Capability tier"), { target: { value: "system" } });

    await waitForContent(
      container,
      "New sessions are limited to the Daintree actions the System capability tier allows"
    );
    expect(container.textContent).not.toContain("the Action capability tier");
  });

  // The gate is what keeps a switch off agents where flipping it does nothing.
  it("hides the bypass toggle for an agent with no bypass mechanism", async () => {
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "byoa"]);
    helpPanelState.preferredAgentId = "byoa";

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Capability tier");

    expect(screen.queryByRole("switch", { name: /bypass|auto-approve/i })).toBeNull();
  });

  it("hides the bypass toggle for an agent that opts out of permission bypass", async () => {
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "gemini"]);
    helpPanelState.preferredAgentId = "gemini";

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Capability tier");

    // A dangerous flag exists for this agent, so only the supports declaration
    // keeps the switch away — and the launch path honours the same declaration.
    expect(screen.queryByRole("switch", { name: /bypass|auto-approve/i })).toBeNull();
    expect(container.textContent).not.toContain("--yolo");
  });

  it("follows the selection when the preferred agent changes", async () => {
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);
    helpPanelState.preferredAgentId = "claude";

    const { container, rerender } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Bypass Claude permission prompts");

    helpPanelState.preferredAgentId = "codex";
    rerender(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );

    await waitForContent(container, "Bypass Codex approvals and sandbox");
    expect(container.textContent).not.toContain("Bypass Claude permission prompts");
  });

  it("hides the bypass toggle and its warning while no agent is selected", async () => {
    helpPanelState.preferredAgentId = null;
    // Persisted ON: the warning banner must be gated on the agent too, not just
    // on the stored boolean, or it renders with no switch to turn it back off.
    installApi({
      getSettings: vi.fn().mockResolvedValue({
        docSearch: true,
        daintreeControl: true,
        tier: "action" as const,
        bypassPermissions: true,
        auditRetention: 7,
        customArgs: "",
      }),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Capability tier");

    expect(screen.queryByRole("switch", { name: /bypass|auto-approve/i })).toBeNull();
    expect(container.textContent).not.toContain("unless an automation grant covers them");
  });

  it("renders exactly the model catalog the resolver returns", async () => {
    helpPanelState.preferredAgentId = "claude";
    window.electron.agentCapabilities.getResolvedModelList = vi.fn().mockResolvedValue({
      agentId: "claude",
      models: [
        { id: "opus", name: "Opus", shortLabel: "Opus" },
        { id: "sonnet", name: "Sonnet", shortLabel: "Sonnet" },
      ],
      contextWindow: 200_000,
      source: "merged",
    });

    render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );

    const select = await screen.findByLabelText("Model");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["Default (CLI default)", "Opus", "Sonnet"]);
  });

  it("changing the capability tier persists tier=system", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Capability tier");

    const select = screen.getByLabelText("Capability tier") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "system" } });

    await waitFor(() => {
      expect(window.electron.helpAssistant.setSettings).toHaveBeenCalledWith({
        tier: "system",
      });
    });
  });

  it("rotate key opens confirm dialog; confirming calls mcpServer.rotateApiKey", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Rotate MCP key");

    fireEvent.click(screen.getByRole("button", { name: /rotate mcp key/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /rotate api key\?/i })).toBeTruthy();
    });
    expect(window.electron.mcpServer.rotateApiKey).not.toHaveBeenCalled();

    const confirmButton = screen.getByRole("button", {
      name: /^rotate key$/i,
    }) as HTMLButtonElement;
    // Rotation is recoverable (#10547): no typed-name gate, button is live immediately.
    expect(confirmButton.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByLabelText(/^Type .* to confirm$/i)).toBeNull();

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(window.electron.mcpServer.rotateApiKey).toHaveBeenCalledTimes(1);
    });
  });

  it("disables the Rotate MCP key button when the API key has not loaded yet", async () => {
    installApi(
      {},
      {
        getStatus: vi.fn().mockResolvedValue({
          enabled: true,
          port: 45454,
          configuredPort: 45454,
          apiKey: "",
        }),
      }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Rotate MCP key");

    const button = screen.getByRole("button", { name: /rotate mcp key/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(screen.queryByRole("heading", { name: /rotate api key\?/i })).toBeNull();
  });

  it("does not expose the full API key in the rotate dialog body", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Rotate MCP key");

    fireEvent.click(screen.getByRole("button", { name: /rotate mcp key/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /rotate api key\?/i })).toBeTruthy();
    });

    const dialogText = document.body.textContent ?? "";
    // The rotate dialog no longer echoes the key suffix (#10547 dropped the typed-name
    // gate), so neither the full key nor any fragment of it appears in the dialog body.
    expect(dialogText).not.toContain("dnt-key-abc");
    expect(dialogText).toContain("The current key will be invalidated immediately");
  });

  it("rotate key dialog can be canceled without rotating", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Rotate MCP key");

    fireEvent.click(screen.getByRole("button", { name: /rotate mcp key/i }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /rotate api key\?/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /rotate api key\?/i })).toBeNull();
    });
    expect(window.electron.mcpServer.rotateApiKey).not.toHaveBeenCalled();
  });

  it("copy MCP config writes the snippet to the clipboard and shows confirmation", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Copy MCP config");

    fireEvent.click(screen.getByRole("button", { name: /copy mcp config/i }));

    await waitFor(() => {
      expect(window.electron.mcpServer.getConfigSnippet).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith('{ "url": "http://127.0.0.1:45454/mcp" }');
    });
    await waitForContent(container, "Copied");
  });

  it("hides connection details and shows guidance when MCP is disabled", async () => {
    installApi(
      {},
      {
        getStatus: vi.fn().mockResolvedValue({
          enabled: false,
          port: null,
          configuredPort: null,
          apiKey: "",
        }),
        getRuntimeState: vi.fn().mockResolvedValue({
          enabled: false,
          state: "disabled",
          port: null,
          lastError: null,
        }),
      }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server is off");

    expect(screen.queryByRole("button", { name: /rotate mcp key/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /copy mcp config/i })).toBeNull();
    expect(screen.getByRole("button", { name: /open mcp server settings/i })).toBeTruthy();
  });

  it("shows the local-server disclosure when Daintree control is on, and hides it when off", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Daintree control");

    // daintreeControl defaults to true in the mocked settings.
    expect(container.textContent).toContain("starts a local HTTP server on 127.0.0.1");

    fireEvent.click(screen.getByLabelText("Allow the assistant to call Daintree control tools"));

    await waitFor(() => {
      expect(container.textContent).not.toContain("starts a local HTTP server on 127.0.0.1");
    });
  });

  it("surfaces the runtime error and a recovery link when the MCP server failed to start", async () => {
    installApi(
      {},
      {
        getRuntimeState: vi.fn().mockResolvedValue({
          enabled: true,
          state: "failed",
          port: null,
          lastError: "EADDRINUSE: port 45454 already in use",
        }),
      }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server failed to start");

    expect(container.textContent).toContain("EADDRINUSE: port 45454 already in use");
    expect(screen.getByRole("button", { name: /open mcp server settings/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy mcp config/i })).toBeNull();
  });

  it("renders the starting state without connection actions", async () => {
    installApi(
      {},
      {
        getRuntimeState: vi.fn().mockResolvedValue({
          enabled: true,
          state: "starting",
          port: null,
          lastError: null,
        }),
      }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Server is starting…");

    expect(screen.queryByRole("button", { name: /copy mcp config/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /rotate mcp key/i })).toBeNull();
  });

  it("still surfaces the failed runtime state when getStatus fails", async () => {
    installApi(
      {},
      {
        getStatus: vi.fn().mockRejectedValue(new Error("ipc down")),
        getRuntimeState: vi.fn().mockResolvedValue({
          enabled: true,
          state: "failed",
          port: null,
          lastError: "EADDRINUSE: port 45454 already in use",
        }),
      }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server failed to start");

    expect(container.textContent).not.toContain("Couldn't load MCP status");
    expect(screen.getByRole("button", { name: /open mcp server settings/i })).toBeTruthy();
  });

  it("renders the failed fallback copy when lastError is null", async () => {
    installApi(
      {},
      {
        getRuntimeState: vi.fn().mockResolvedValue({
          enabled: true,
          state: "failed",
          port: null,
          lastError: null,
        }),
      }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Check the MCP server tab for details");
  });

  it("hides the local-server disclosure when Daintree control is persisted off", async () => {
    installApi({
      getSettings: vi.fn().mockResolvedValue({
        docSearch: true,
        daintreeControl: false,
        tier: "action" as const,
        bypassPermissions: false,
        auditRetention: 7,
        customArgs: "",
      }),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Daintree control");

    expect(container.textContent).not.toContain("starts a local HTTP server on 127.0.0.1");
  });

  it("lists Codex in the agent dropdown when it passes the assistant gate", async () => {
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Search documentation");

    const select = container.querySelector("select[aria-label='Agent']");
    expect(select).toBeInstanceOf(HTMLSelectElement);
    if (!(select instanceof HTMLSelectElement)) throw new Error("select not found");
    const labels = Array.from(select.options).map((o) => o.textContent ?? "");
    expect(labels).toContain("Claude Code");
    expect(labels).toContain("Codex");
  });

  it("hides Codex from the dropdown when only Claude passes the assistant gate", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Search documentation");

    const select = container.querySelector("select[aria-label='Agent']");
    expect(select).toBeInstanceOf(HTMLSelectElement);
    if (!(select instanceof HTMLSelectElement)) throw new Error("select not found");
    const labels = Array.from(select.options).map((o) => o.textContent ?? "");
    expect(labels).toContain("Claude Code");
    expect(labels).not.toContain("Codex");
  });

  it("does not render a Preferred model section", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Search documentation");

    expect(container.textContent).not.toContain("Preferred model");
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("keeps settings visible when MCP status load fails", async () => {
    installApi(
      {
        getSettings: vi.fn().mockResolvedValue({
          docSearch: false,
          daintreeControl: true,
          tier: "action" as const,
          bypassPermissions: false,
          auditRetention: 7,
        }),
      },
      { getStatus: vi.fn().mockRejectedValue(new Error("ipc down")) }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Couldn't load MCP status");

    await waitFor(() => {
      const docSearchToggle = screen.getByLabelText(
        "Allow the assistant to search Daintree documentation"
      );
      expect(docSearchToggle.getAttribute("data-state")).toBe("unchecked");
    });
  });

  it("surfaces a setSettings IPC failure as an inline error banner", async () => {
    installApi({
      setSettings: vi.fn().mockRejectedValue(new Error("disk full")),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Search documentation");

    fireEvent.click(screen.getByLabelText("Allow the assistant to search Daintree documentation"));

    await waitForContent(container, "disk full");
  });

  it("does not flash 'Copied' when clipboard.writeText rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("permission denied"));

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Copy MCP config");

    fireEvent.click(screen.getByRole("button", { name: /copy mcp config/i }));

    await waitFor(() => {
      expect(window.electron.mcpServer.getConfigSnippet).toHaveBeenCalled();
    });
    expect(container.textContent).not.toContain("Copied");
  });

  it("does not call setEnabled when toggling Daintree control off", async () => {
    const setEnabled = vi.fn();
    installApi({}, { setEnabled });

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Daintree control");

    fireEvent.click(screen.getByLabelText("Allow the assistant to call Daintree control tools"));

    await waitFor(() => {
      expect(window.electron.helpAssistant.setSettings).toHaveBeenCalledWith({
        daintreeControl: false,
      });
    });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("audit retention select offers off / 7 / 30 day options and persists changes", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Audit log retention");

    const select = screen.getByLabelText("Audit log retention") as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.label);
    expect(optionLabels).toEqual(["7 days (default)", "30 days", "Off"]);

    fireEvent.change(select, { target: { value: "30" } });

    await waitFor(() => {
      expect(window.electron.helpAssistant.setSettings).toHaveBeenCalledWith({
        auditRetention: 30,
      });
    });
  });

  it("renders an agent dropdown listing assistant-supported agents", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Agent");

    const select = screen.getByRole("combobox", { name: "Agent" }) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.label);
    expect(labels).toContain("Claude Code");
  });

  it("calls helpPanelStore.setPreferredAgent when the agent dropdown changes", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Agent");

    const select = screen.getByRole("combobox", { name: "Agent" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "claude" } });

    expect(helpPanelState.setPreferredAgent).toHaveBeenCalledWith("claude");
  });

  it("shows the dropped-agent banner when a persisted agent was dropped", async () => {
    helpPanelState.droppedPreferredAgentId = "claude";

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Agent");

    const banner = await screen.findByTestId("assistant-dropped-agent-banner");
    expect(banner.textContent).toContain("Claude Code is no longer available");
  });

  it("hides the dropped-agent banner when nothing was dropped", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Agent");

    expect(screen.queryByTestId("assistant-dropped-agent-banner")).toBeNull();
  });

  it("dismissing the dropped-agent banner calls clearDroppedPreferredAgent", async () => {
    helpPanelState.droppedPreferredAgentId = "claude";

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Agent");

    const banner = await screen.findByTestId("assistant-dropped-agent-banner");
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));

    expect(helpPanelState.clearDroppedPreferredAgent).toHaveBeenCalledTimes(1);
  });

  it("warns when the selected agent's CLI is older than the assistant minimum", async () => {
    helpPanelState.preferredAgentId = "claude";
    installApi(
      {},
      {},
      {
        getAgentVersion: vi.fn().mockResolvedValue({
          agentId: "claude",
          installedVersion: "1.0.0",
          latestVersion: null,
          updateAvailable: false,
          lastChecked: null,
        }),
      }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Agent");

    const banner = await screen.findByTestId("assistant-version-warning-banner");
    expect(banner.textContent).toContain("Claude Code needs an update");
    expect(banner.textContent).toContain("2.0.0");
    expect(banner.textContent).toContain("1.0.0");
    expect(window.electron.system.getAgentVersion).toHaveBeenCalledWith("claude");
  });

  it("does not warn when the installed CLI meets the assistant minimum", async () => {
    helpPanelState.preferredAgentId = "claude";
    installApi(
      {},
      {},
      {
        getAgentVersion: vi.fn().mockResolvedValue({
          agentId: "claude",
          installedVersion: "2.5.0",
          latestVersion: null,
          updateAvailable: false,
          lastChecked: null,
        }),
      }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Agent");
    await waitFor(() => {
      expect(window.electron.system.getAgentVersion).toHaveBeenCalledWith("claude");
    });

    expect(screen.queryByTestId("assistant-version-warning-banner")).toBeNull();
  });

  it("clears the version warning when switching to an agent with no minimum", async () => {
    helpPanelState.preferredAgentId = "claude";
    installApi(
      {},
      {},
      {
        getAgentVersion: vi.fn().mockResolvedValue({
          agentId: "claude",
          installedVersion: "1.0.0",
          latestVersion: null,
          updateAvailable: false,
          lastChecked: null,
        }),
      }
    );

    const { rerender } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await screen.findByTestId("assistant-version-warning-banner");

    // Codex has no assistantMinVersion in the mock, so the probe effect must
    // clear the prior agent's warning synchronously on switch.
    helpPanelState.preferredAgentId = "codex";
    rerender(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );

    await waitFor(() => {
      expect(screen.queryByTestId("assistant-version-warning-banner")).toBeNull();
    });
  });

  it("does not probe versions when no agent is selected", async () => {
    helpPanelState.preferredAgentId = null;

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Agent");

    expect(screen.queryByTestId("assistant-version-warning-banner")).toBeNull();
    expect(window.electron.system.getAgentVersion).not.toHaveBeenCalled();
  });

  it("audit retention description no longer claims logging can be skipped entirely", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Audit log retention");

    expect(container.textContent).not.toContain("skip logging entirely");
    expect(container.textContent).toContain("recorded separately");
  });

  it("renders turn-outcome diagnostics in the privacy section after expanding advanced diagnostics", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Advanced diagnostics");

    // Diagnostics are collapsed by default — the turn-outcome block is unmounted
    // until the disclosure is opened.
    expect(container.textContent).not.toContain("Turn outcomes by class");

    fireEvent.click(screen.getByRole("button", { name: "Advanced diagnostics" }));

    await waitForContent(container, "Turn outcomes by class");
  });

  it("renders the recording toggle in the privacy section, on by default", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Capture audit log");

    expect(window.electron.mcpServer.getAuditConfig).toHaveBeenCalledTimes(1);
    const toggle = screen.getByLabelText("Capture audit log");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Recording every dispatch");
  });

  it("toggling the recording switch off calls setAuditEnabled(false) and updates the subtitle", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Capture audit log");

    // The toggle is disabled until getAuditConfig resolves (auditLoading) so the
    // late config fulfillment can't clobber a user toggle — wait for it to enable.
    const toggle = screen.getByLabelText("Capture audit log");
    await waitFor(() => {
      expect(toggle.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(window.electron.mcpServer.setAuditEnabled).toHaveBeenCalledWith(false);
    });
    await waitForContent(container, "New dispatches will not be recorded");
    expect(screen.getByLabelText("Capture audit log").getAttribute("aria-checked")).toBe("false");
  });

  it("surfaces an inline error when setAuditEnabled rejects, leaving recording on", async () => {
    installApi(
      {},
      {
        setAuditEnabled: vi.fn().mockRejectedValue(new Error("audit ipc failed")),
      }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Capture audit log");

    const toggle = screen.getByLabelText("Capture audit log");
    await waitFor(() => {
      expect(toggle.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(toggle);

    await waitForContent(container, "audit ipc failed");
    // Recording state holds at the last known-good value on failure.
    expect(screen.getByLabelText("Capture audit log").getAttribute("aria-checked")).toBe("true");
  });

  it("reflects recording-off state loaded from getAuditConfig", async () => {
    installApi(
      {},
      {
        getAuditConfig: vi.fn().mockResolvedValue({ enabled: false, maxRecords: 500 }),
      }
    );

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Capture audit log");

    await waitForContent(container, "New dispatches will not be recorded");
    expect(screen.getByLabelText("Capture audit log").getAttribute("aria-checked")).toBe("false");
  });

  it("loads customArgs from the IPC settings into the input", async () => {
    installApi({
      getSettings: vi.fn().mockResolvedValue({
        docSearch: true,
        daintreeControl: true,
        tier: "action" as const,
        bypassPermissions: false,
        auditRetention: 7,
        customArgs: "--model sonnet",
      }),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Custom CLI args");

    const input = screen.getByLabelText("Custom CLI args") as HTMLInputElement;
    expect(input.value).toBe("--model sonnet");
  });

  it("persists customArgs via setSettings on input change", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Custom CLI args");

    const input = screen.getByLabelText("Custom CLI args") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "--model sonnet" } });

    await waitFor(() => {
      expect(window.electron.helpAssistant.setSettings).toHaveBeenCalledWith({
        customArgs: "--model sonnet",
      });
    });
  });

  it("persists an empty customArgs string when the user clears the input", async () => {
    installApi({
      getSettings: vi.fn().mockResolvedValue({
        docSearch: true,
        daintreeControl: true,
        tier: "action" as const,
        bypassPermissions: false,
        auditRetention: 7,
        customArgs: "--model sonnet",
      }),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Custom CLI args");

    const input = screen.getByLabelText("Custom CLI args") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    await waitFor(() => {
      expect(window.electron.helpAssistant.setSettings).toHaveBeenCalledWith({
        customArgs: "",
      });
    });
  });
});

describe("SessionLiveStatusCard (live help session)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helpPanelState.preferredAgentId = null;
    helpPanelState.sessionId = "help-1";
    helpPanelState.setPreferredAgent = vi.fn();
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    helpPanelState.sessionId = null;
  });

  const settingsWithTier = (tier: "workbench" | "action" | "system") => ({
    docSearch: true,
    daintreeControl: true,
    tier,
    bypassPermissions: false,
    auditRetention: 7 as const,
    customArgs: "",
    idleHibernateMinutes: 30 as const,
  });

  it("reports the live tier as elevated above the configured default", async () => {
    installApi(
      {
        getSettings: vi.fn().mockResolvedValue(settingsWithTier("action")),
        getLiveSessionStatus: vi
          .fn()
          .mockResolvedValue({ connected: true, tier: "system", activeGrants: [] }),
      },
      {}
    );
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );

    await waitFor(() => expect(container.textContent).toContain("Live session"), { timeout: 5000 });
    expect(container.textContent).toContain("elevated above the configured action default");
  });

  it("reports a live tier below the configured default without claiming a match", async () => {
    installApi(
      {
        getSettings: vi.fn().mockResolvedValue(settingsWithTier("system")),
        getLiveSessionStatus: vi
          .fn()
          .mockResolvedValue({ connected: true, tier: "action", activeGrants: [] }),
      },
      {}
    );
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );

    await waitFor(() => expect(container.textContent).toContain("Live session"), { timeout: 5000 });
    expect(container.textContent).toContain("below the configured system default");
    expect(container.textContent).not.toContain("matches the configured default");
  });

  // The equality branch is the one a default (action-tier) assistant session
  // lands on now that agent identity no longer forces `system` (#11907). The
  // copy was previously unasserted — only the two drift directions were.
  it("reports a live tier equal to the configured default as a match", async () => {
    installApi(
      {
        getSettings: vi.fn().mockResolvedValue(settingsWithTier("action")),
        getLiveSessionStatus: vi
          .fn()
          .mockResolvedValue({ connected: true, tier: "action", activeGrants: [] }),
      },
      {}
    );
    const { container } = render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );

    await waitFor(() => expect(container.textContent).toContain("Live session"), { timeout: 5000 });
    expect(container.textContent).toContain("matches the configured default");
    expect(container.textContent).not.toContain("elevated above");
    expect(container.textContent).not.toContain("below the configured");
  });

  it("passes the public help-session id to the live-status bridge call", async () => {
    const getLiveSessionStatus = vi
      .fn()
      .mockResolvedValue({ connected: true, tier: "action", activeGrants: [] });
    installApi(
      { getSettings: vi.fn().mockResolvedValue(settingsWithTier("action")), getLiveSessionStatus },
      {}
    );
    render(
      <SettingsValidationProvider>
        <DaintreeAssistantSettingsTab />
      </SettingsValidationProvider>
    );

    await waitFor(() => expect(getLiveSessionStatus).toHaveBeenCalledWith({ sessionId: "help-1" }));
  });
});

describe("formatGrantRemaining", () => {
  it("renders sub-minute durations as bare seconds", () => {
    expect(formatGrantRemaining(0)).toBe("0s");
    expect(formatGrantRemaining(1)).toBe("1s");
    expect(formatGrantRemaining(59)).toBe("59s");
  });

  it("renders an exact minute without a trailing seconds component", () => {
    expect(formatGrantRemaining(60)).toBe("1m");
    expect(formatGrantRemaining(120)).toBe("2m");
  });

  it("renders mixed minute+second durations", () => {
    expect(formatGrantRemaining(61)).toBe("1m 1s");
    expect(formatGrantRemaining(125)).toBe("2m 5s");
  });

  it("floors fractional seconds and clamps negatives to zero", () => {
    expect(formatGrantRemaining(61.9)).toBe("1m 1s");
    expect(formatGrantRemaining(-5)).toBe("0s");
  });
});
