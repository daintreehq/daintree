// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServerSettingsTab } from "../McpServerSettingsTab";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";

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
    McpServerIcon: stub,
    DaintreeIcon: stub,
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
vi.mock("@/config/agents", () => ({
  getAgentIds: () => [],
  getAssistantSupportedAgentIds: () => [],
  getAgentConfig: () => undefined,
}));

const mockedNotify = vi.mocked(notify);
const mockedLogError = vi.mocked(logError);

function createMcpApi(overrides: Partial<typeof window.electron.mcpServer> = {}) {
  return {
    getStatus: vi.fn().mockResolvedValue({
      enabled: true,
      port: 9020,
      configuredPort: 9020,
      apiKey: "dnt-key-abc123",
    }),
    getRuntimeState: vi.fn().mockResolvedValue({
      enabled: true,
      state: "ready",
      port: 9020,
      lastError: null,
    }),
    setEnabled: vi.fn(),
    setPort: vi.fn(),
    listActiveClients: vi.fn().mockResolvedValue([]),
    getConfigSnippet: vi.fn().mockResolvedValue("http://127.0.0.1:9020/sse"),
    rotateApiKey: vi.fn().mockResolvedValue("dnt-key-rotated789"),
    getLogRecords: vi.fn().mockResolvedValue([]),
    getAuditConfig: vi.fn().mockResolvedValue({ enabled: true, maxRecords: 500 }),
    getAuditStats: vi.fn().mockResolvedValue({
      auth401Count: 0,
      anomalySignals: [],
      anomalySuppressed: true,
      anomalyRecordFloor: 50,
    }),
    clearAuditLog: vi.fn().mockResolvedValue(undefined),
    setAuditEnabled: vi.fn().mockResolvedValue({ enabled: true, maxRecords: 500 }),
    setAuditMaxRecords: vi.fn().mockResolvedValue({ enabled: true, maxRecords: 500 }),
    getTurnOutcomeRecords: vi.fn().mockResolvedValue([]),
    clearTurnOutcomeLog: vi.fn().mockResolvedValue(undefined),
    onRuntimeStateChanged: vi.fn().mockReturnValue(vi.fn()),
    listActiveBearers: vi.fn().mockResolvedValue([]),
    listHelpSessionBearers: vi.fn().mockResolvedValue([]),
    disconnectBearer: vi.fn().mockResolvedValue({ tokenHash: "", disconnected: true }),
    ...overrides,
  };
}

const writeText = vi.fn().mockResolvedValue(undefined);

function installMcpApi(
  overrides: Partial<typeof window.electron.mcpServer> = {},
  helpAssistantOverrides: Partial<typeof window.electron.helpAssistant> = {}
) {
  window.electron = {
    mcpServer: createMcpApi(overrides),
    helpAssistant: {
      getSettings: vi.fn().mockResolvedValue({ daintreeControl: false }),
      setSettings: vi.fn().mockResolvedValue(undefined),
      ...helpAssistantOverrides,
    },
  } as unknown as typeof window.electron;
}

describe("McpServerSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    installMcpApi();
  });

  const waitForContent = (container: HTMLElement, text: string) =>
    waitFor(
      () => {
        expect(container.textContent).toContain(text);
      },
      { timeout: 5000 }
    );

  it("renders API key in a non-input display element", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    const displayArea = container.querySelector(".bg-surface-disabled");
    expect(displayArea).toBeTruthy();
    expect(displayArea?.tagName).toBe("DIV");

    const inputs = container.querySelectorAll("input[readonly]");
    expect(inputs.length).toBe(0);
  });

  it("shows masked bullets by default, reveals key on toggle", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    const displayArea = container.querySelector(".bg-surface-disabled")!;
    expect(displayArea.textContent).not.toContain("dnt-key-abc123");
    expect(displayArea.textContent).toContain("•");

    fireEvent.click(screen.getByLabelText("Show API key"));
    await waitFor(() => {
      expect(displayArea.textContent).toContain("dnt-key-abc123");
    });

    fireEvent.click(screen.getByLabelText("Hide API key"));
    await waitFor(() => {
      expect(displayArea.textContent).not.toContain("dnt-key-abc123");
    });
  });

  it("copy button writes unmasked key to clipboard", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByLabelText("Copy API key"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("dnt-key-abc123");
    });
  });

  it("copy button shows Copied! feedback", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByLabelText("Copy API key"));

    await waitFor(() => {
      expect(screen.getByText("Copied!")).toBeTruthy();
    });
    expect(writeText).toHaveBeenCalledWith("dnt-key-abc123");
  });

  it("Rotate opens confirm dialog; confirming calls rotateApiKey and keeps key masked", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByTitle("Rotate API key"));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /rotate api key\?/i })).toBeTruthy();
    });
    expect(window.electron.mcpServer.rotateApiKey).not.toHaveBeenCalled();

    const confirmButton = screen.getByRole("button", {
      name: /^rotate key$/i,
    }) as HTMLButtonElement;
    // Rotation is recoverable (#10547): no typed-name gate, button is live immediately.
    expect(confirmButton.disabled).toBe(false);
    expect(screen.queryByLabelText(/^Type .* to confirm$/i)).toBeNull();

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(window.electron.mcpServer.rotateApiKey).toHaveBeenCalledTimes(1);
    });

    const displayArea = container.querySelector(".bg-surface-disabled")!;
    await waitFor(() => {
      expect(displayArea.textContent).not.toContain("dnt-key-rotated789");
    });
    expect(displayArea.textContent).toContain("•");
  });

  it("Rotate dialog can be canceled without rotating the key", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByTitle("Rotate API key"));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /rotate api key\?/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /rotate api key\?/i })).toBeNull();
    });
    expect(window.electron.mcpServer.rotateApiKey).not.toHaveBeenCalled();
  });

  it("Confirming rotation re-masks the display even if the key was previously revealed", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByLabelText("Show API key"));
    const displayArea = container.querySelector(".bg-surface-disabled")!;
    await waitFor(() => {
      expect(displayArea.textContent).toContain("dnt-key-abc123");
    });

    fireEvent.click(screen.getByTitle("Rotate API key"));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /rotate api key\?/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^rotate key$/i }));

    await waitFor(() => {
      expect(window.electron.mcpServer.rotateApiKey).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(displayArea.textContent).not.toContain("dnt-key-rotated789");
    });
    expect(displayArea.textContent).not.toContain("dnt-key-abc123");
    expect(displayArea.textContent).toContain("•");
  });

  it("Rotation failure keeps the dialog open and surfaces the error", async () => {
    installMcpApi({
      rotateApiKey: vi.fn().mockRejectedValue(new Error("rotate failed")),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByTitle("Rotate API key"));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /rotate api key\?/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^rotate key$/i }));

    await waitForContent(container, "rotate failed");
    expect(screen.getByRole("heading", { name: /rotate api key\?/i })).toBeTruthy();
    expect(window.electron.mcpServer.rotateApiKey).toHaveBeenCalledTimes(1);
    expect(mockedLogError).toHaveBeenCalledWith("Failed to rotate MCP API key", expect.any(Error));
  });

  it("Canceling the rotate dialog hides any revealed key", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByLabelText("Show API key"));
    const displayArea = container.querySelector(".bg-surface-disabled")!;
    await waitFor(() => {
      expect(displayArea.textContent).toContain("dnt-key-abc123");
    });

    fireEvent.click(screen.getByTitle("Rotate API key"));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /rotate api key\?/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => {
      expect(displayArea.textContent).not.toContain("dnt-key-abc123");
    });
    expect(displayArea.textContent).toContain("•");
  });

  it("Masked display uses a fixed-length bullet mask regardless of key length", async () => {
    installMcpApi({
      getStatus: vi.fn().mockResolvedValue({
        enabled: true,
        port: 9020,
        configuredPort: 9020,
        apiKey: "dnt-key-short",
      }),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    const displayArea = container.querySelector(".bg-surface-disabled")!;
    const maskSpan = displayArea.querySelector("span")!;
    const bulletCount = (maskSpan.textContent ?? "").length;
    expect(bulletCount).toBe(24);
    expect(bulletCount).not.toBe("dnt-key-short".length);
  });

  it("shows inline error and logs API key copy failure without notifying", async () => {
    const writeTextReject = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextReject },
      writable: true,
      configurable: true,
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByLabelText("Copy API key"));

    await waitForContent(container, "clipboard denied");
    expect(mockedNotify).not.toHaveBeenCalled();
    expect(mockedLogError).toHaveBeenCalledWith("Failed to copy MCP API key", expect.any(Error));
  });

  it("does not render a Remove button — the key is mandatory", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
  });

  it("shows inline error and logs IPC failure without notifying", async () => {
    installMcpApi({
      getStatus: vi.fn().mockRejectedValue(new Error("IPC down")),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );

    await waitForContent(container, "IPC down");

    expect(mockedNotify).not.toHaveBeenCalled();
    expect(mockedLogError).toHaveBeenCalledWith("Failed to load MCP status", expect.any(Error));
  });

  it("renders empty state with 'Turn on MCP server' CTA when MCP is disabled", async () => {
    installMcpApi({
      getStatus: vi.fn().mockResolvedValue({
        enabled: false,
        port: null,
        configuredPort: null,
        apiKey: "",
      }),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server is off");

    expect(screen.getByRole("button", { name: /turn on mcp server/i })).toBeTruthy();
  });

  it("clicking 'Turn on MCP server' from the empty state calls setEnabled(true)", async () => {
    const setEnabledMock = vi.fn().mockResolvedValue({
      enabled: true,
      port: 9020,
      configuredPort: 9020,
      apiKey: "",
    });
    installMcpApi({
      getStatus: vi.fn().mockResolvedValue({
        enabled: false,
        port: null,
        configuredPort: null,
        apiKey: "",
      }),
      setEnabled: setEnabledMock,
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server is off");

    fireEvent.click(screen.getByRole("button", { name: /turn on mcp server/i }));

    await waitFor(() => {
      expect(setEnabledMock).toHaveBeenCalledWith(true);
    });
  });

  it("does not render the empty state while MCP status is still loading", () => {
    installMcpApi({
      // Pending forever so the loading state is the rendered state.
      getStatus: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    expect(screen.queryByText("MCP server is off")).toBeNull();
  });

  it("hides the empty state once MCP is enabled", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    expect(screen.queryByText("MCP server is off")).toBeNull();
  });

  it("does not show the empty state when MCP status load fails", async () => {
    installMcpApi({
      getStatus: vi.fn().mockRejectedValue(new Error("IPC down")),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );

    await waitForContent(container, "IPC down");

    expect(screen.queryByText("MCP server is off")).toBeNull();
  });

  it("hides the empty state once MCP is enabled via the CTA", async () => {
    const setEnabledMock = vi.fn().mockResolvedValue({
      enabled: true,
      port: 9020,
      configuredPort: 9020,
      apiKey: "",
    });
    installMcpApi({
      getStatus: vi.fn().mockResolvedValue({
        enabled: false,
        port: null,
        configuredPort: null,
        apiKey: "",
      }),
      setEnabled: setEnabledMock,
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server is off");

    fireEvent.click(screen.getByRole("button", { name: /turn on mcp server/i }));

    await waitFor(() => {
      expect(screen.queryByText("MCP server is off")).toBeNull();
    });
  });

  it("shows inline error and logs toggle failure without notifying", async () => {
    installMcpApi({
      setEnabled: vi.fn().mockRejectedValue(new Error("toggle failed")),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server");

    fireEvent.click(screen.getByLabelText("Enable MCP server"));

    await waitForContent(container, "toggle failed");
    expect(mockedNotify).not.toHaveBeenCalled();
    expect(mockedLogError).toHaveBeenCalledWith("Failed to update MCP server", expect.any(Error));
  });

  it("disabling with connected external clients opens a confirm dialog naming them before stopping (#8779)", async () => {
    const setEnabledMock = vi.fn().mockResolvedValue({
      enabled: false,
      port: null,
      configuredPort: 9020,
      apiKey: "dnt-key-abc123",
    });
    installMcpApi({
      setEnabled: setEnabledMock,
      listActiveClients: vi.fn().mockResolvedValue([
        {
          sessionId: "s1",
          userAgent: "Claude Code/1.2",
          connectedAtMs: Date.now() - 120_000,
          transport: "streamable-http",
        },
      ]),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server");

    fireEvent.click(screen.getByLabelText("Enable MCP server"));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /stop mcp server\?/i })).toBeTruthy();
    });
    // The named client must appear; setEnabled must not have fired yet.
    expect(screen.getByText("Claude Code/1.2")).toBeTruthy();
    expect(setEnabledMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^stop sharing$/i }));

    await waitFor(() => {
      expect(setEnabledMock).toHaveBeenCalledWith(false);
    });
  });

  it("Stop dialog can be canceled without disabling the server (#8779)", async () => {
    const setEnabledMock = vi.fn();
    installMcpApi({
      setEnabled: setEnabledMock,
      listActiveClients: vi.fn().mockResolvedValue([
        {
          sessionId: "s1",
          userAgent: "Cursor/0.9",
          connectedAtMs: Date.now(),
          transport: "sse",
        },
      ]),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server");

    fireEvent.click(screen.getByLabelText("Enable MCP server"));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /stop mcp server\?/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^keep running$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /stop mcp server\?/i })).toBeNull();
    });
    expect(setEnabledMock).not.toHaveBeenCalled();
  });

  it("disabling with no connected clients stops immediately without a dialog (#8779)", async () => {
    const setEnabledMock = vi.fn().mockResolvedValue({
      enabled: false,
      port: null,
      configuredPort: 9020,
      apiKey: "dnt-key-abc123",
    });
    installMcpApi({
      setEnabled: setEnabledMock,
      listActiveClients: vi.fn().mockResolvedValue([]),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server");

    fireEvent.click(screen.getByLabelText("Enable MCP server"));

    await waitFor(() => {
      expect(setEnabledMock).toHaveBeenCalledWith(false);
    });
    expect(screen.queryByRole("heading", { name: /stop mcp server\?/i })).toBeNull();
  });

  it("surfaces an error and does not stop the server when listActiveClients fails (#8779)", async () => {
    const setEnabledMock = vi.fn();
    installMcpApi({
      setEnabled: setEnabledMock,
      listActiveClients: vi.fn().mockRejectedValue(new Error("clients lookup failed")),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "MCP server");

    fireEvent.click(screen.getByLabelText("Enable MCP server"));

    await waitForContent(container, "clients lookup failed");
    expect(setEnabledMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: /stop mcp server\?/i })).toBeNull();
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("shows inline error for invalid audit max records instead of notifying", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    const maxRecordsInput = container.querySelector("#mcp-audit-max-records") as HTMLInputElement;
    fireEvent.change(maxRecordsInput, { target: { value: "99999" } });
    fireEvent.keyDown(maxRecordsInput, { key: "Enter" });

    await waitForContent(container, "Enter a number between");
    expect(window.electron.mcpServer.setAuditMaxRecords).not.toHaveBeenCalled();
    expect(mockedNotify).not.toHaveBeenCalled();
    expect(mockedLogError).not.toHaveBeenCalled();
  });

  it("shows inline error and logs audit toggle failure without notifying", async () => {
    installMcpApi({
      setAuditEnabled: vi.fn().mockRejectedValue(new Error("audit toggle failed")),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByRole("switch", { name: /capture audit log/i }));

    await waitForContent(container, "audit toggle failed");
    expect(mockedNotify).not.toHaveBeenCalled();
    expect(mockedLogError).toHaveBeenCalledWith(
      "Failed to toggle MCP audit log",
      expect.any(Error)
    );
  });

  it("clears audit log via confirm dialog without notifying", async () => {
    installMcpApi({
      getLogRecords: vi.fn().mockResolvedValue([
        {
          id: "1",
          toolId: "files.read",
          argsSummary: "{}",
          result: "success" as const,
          timestamp: Date.now(),
          durationMs: 42,
        },
      ]),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "files.read");

    fireEvent.click(screen.getAllByRole("button", { name: /^clear log$/i })[0]!);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /clear audit log\?/i })).toBeTruthy();
    });
    expect(window.electron.mcpServer.clearAuditLog).not.toHaveBeenCalled();

    const buttons = screen.getAllByRole("button", { name: /^clear log$/i });
    const dialogConfirm = buttons[buttons.length - 1]!;
    fireEvent.click(dialogConfirm);

    await waitForContent(container, "No tool dispatches recorded yet");
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("Clear log dialog can be canceled without clearing", async () => {
    installMcpApi({
      getLogRecords: vi.fn().mockResolvedValue([
        {
          id: "1",
          toolId: "files.read",
          argsSummary: "{}",
          result: "success" as const,
          timestamp: Date.now(),
          durationMs: 42,
        },
      ]),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "files.read");

    fireEvent.click(screen.getAllByRole("button", { name: /^clear log$/i })[0]!);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /clear audit log\?/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /clear audit log\?/i })).toBeNull();
    });
    expect(window.electron.mcpServer.clearAuditLog).not.toHaveBeenCalled();
    expect(container.textContent).toContain("files.read");
  });

  it("shows inline error and logs audit clear failure without notifying", async () => {
    installMcpApi({
      getLogRecords: vi.fn().mockResolvedValue([
        {
          id: "1",
          toolId: "files.read",
          argsSummary: "{}",
          result: "success" as const,
          timestamp: Date.now(),
          durationMs: 42,
        },
      ]),
      clearAuditLog: vi.fn().mockRejectedValue(new Error("clear failed")),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "files.read");

    fireEvent.click(screen.getAllByRole("button", { name: /^clear log$/i })[0]!);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /clear audit log\?/i })).toBeTruthy();
    });

    const buttons = screen.getAllByRole("button", { name: /^clear log$/i });
    const dialogConfirm = buttons[buttons.length - 1]!;
    fireEvent.click(dialogConfirm);

    await waitForContent(container, "clear failed");
    expect(mockedNotify).not.toHaveBeenCalled();
    expect(mockedLogError).toHaveBeenCalledWith("Failed to clear MCP audit log", expect.any(Error));
  });

  it("shows Copied! pill on audit copy instead of notifying", async () => {
    installMcpApi({
      getLogRecords: vi.fn().mockResolvedValue([
        {
          id: "1",
          toolId: "files.read",
          argsSummary: "{}",
          result: "success" as const,
          timestamp: Date.now(),
          durationMs: 42,
        },
      ]),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "files.read");

    fireEvent.click(screen.getByRole("button", { name: /copy all as json/i }));

    await waitFor(() => {
      expect(screen.getByText("Copied!")).toBeTruthy();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const jsonArg = String(writeText.mock.calls[0]![0]);
    const parsed: unknown = JSON.parse(jsonArg);
    expect(Array.isArray(parsed)).toBe(true);
    if (!Array.isArray(parsed)) throw new Error("expected array");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by Array.isArray guard above
    const arr = parsed as Array<{ id: string; toolId: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.id).toBe("1");
    expect(arr[0]!.toolId).toBe("files.read");
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("shows inline error and logs audit copy failure without notifying", async () => {
    const writeTextReject = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextReject },
      writable: true,
      configurable: true,
    });
    installMcpApi({
      getLogRecords: vi.fn().mockResolvedValue([
        {
          id: "1",
          toolId: "files.read",
          argsSummary: "{}",
          result: "success" as const,
          timestamp: Date.now(),
          durationMs: 42,
        },
      ]),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "files.read");

    fireEvent.click(screen.getByRole("button", { name: /copy all as json/i }));

    await waitForContent(container, "clipboard denied");
    expect(mockedNotify).not.toHaveBeenCalled();
    expect(mockedLogError).toHaveBeenCalledWith("Failed to copy MCP audit log", expect.any(Error));
  });

  it("shows filtered count when a result filter is active", async () => {
    installMcpApi({
      getLogRecords: vi.fn().mockResolvedValue([
        {
          id: "1",
          toolId: "files.read",
          argsSummary: "{}",
          result: "success" as const,
          timestamp: Date.now(),
          durationMs: 42,
        },
        {
          id: "2",
          toolId: "terminal.run",
          argsSummary: "{}",
          result: "error" as const,
          timestamp: Date.now(),
          durationMs: 100,
        },
      ]),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "files.read");
    // Initially unfiltered: "2 of 500"
    expect(container.textContent).toContain("2 of 500");

    fireEvent.change(screen.getByLabelText("Filter audit by result"), {
      target: { value: "success" },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("1 of 2");
    });
  });

  it("shows filtered count when tool filter is active", async () => {
    installMcpApi({
      getLogRecords: vi.fn().mockResolvedValue([
        {
          id: "1",
          toolId: "files.read",
          argsSummary: "{}",
          result: "success" as const,
          timestamp: Date.now(),
          durationMs: 42,
        },
        {
          id: "2",
          toolId: "terminal.run",
          argsSummary: "{}",
          result: "success" as const,
          timestamp: Date.now(),
          durationMs: 100,
        },
      ]),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "files.read");

    fireEvent.change(screen.getByLabelText("Filter audit by tool name"), {
      target: { value: "terminal" },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("1 of 2");
    });
  });

  it("port input Apply button stays disabled when value has trailing whitespace matching configuredPort", async () => {
    installMcpApi({
      getStatus: vi.fn().mockResolvedValue({
        enabled: true,
        port: 9020,
        configuredPort: 9020,
        apiKey: "dnt-key-abc123",
      }),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    const portInput = screen.getByLabelText("MCP server port") as HTMLInputElement;
    fireEvent.change(portInput, { target: { value: "9020 " } });

    const applyButton = screen.getByRole("button", { name: "Apply port" }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
  });

  it("subscribes to runtime state changes on mount and unsubscribes on unmount", async () => {
    const unsub = vi.fn();
    const onRuntimeStateChanged = vi.fn().mockReturnValue(unsub);

    installMcpApi({ onRuntimeStateChanged });

    const { unmount } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );

    await waitFor(() => {
      expect(onRuntimeStateChanged).toHaveBeenCalledTimes(1);
    });
    expect(unsub).not.toHaveBeenCalled();

    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("result filter includes Unauthorized option", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    const select = screen.getByLabelText("Filter audit by result") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(Array.from(select.options).map((o) => o.value)).toContain("unauthorized");
  });

  it("renders anomaly banner when getAuditStats returns signals", async () => {
    installMcpApi({
      getAuditStats: vi.fn().mockResolvedValue({
        auth401Count: 0,
        anomalySignals: [
          {
            id: "latency-drift:1",
            kind: "latency-drift",
            toolId: "slow.tool",
            severity: "danger",
            timestamp: Date.now() - 3_600_001,
            recordIds: ["r1"],
            zScore: 4.2,
            durationMs: 5000,
            baselineMedianMs: 10,
          },
        ],
        anomalySuppressed: false,
        anomalyRecordFloor: 50,
      }),
      getLogRecords: vi.fn().mockResolvedValue([
        {
          id: "r1",
          toolId: "slow.tool",
          argsSummary: "{}",
          result: "success" as const,
          timestamp: Date.now(),
          durationMs: 5000,
        },
      ]),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "anomaly signal");
  });

  it("hides anomaly banner when suppressed", async () => {
    installMcpApi({
      getAuditStats: vi.fn().mockResolvedValue({
        auth401Count: 0,
        anomalySignals: [
          {
            id: "latency-drift:1",
            kind: "latency-drift",
            toolId: "slow.tool",
            severity: "danger",
            timestamp: Date.now(),
            recordIds: ["r1"],
            zScore: 4.2,
            durationMs: 5000,
            baselineMedianMs: 10,
          },
        ],
        anomalySuppressed: true,
        anomalyRecordFloor: 50,
      }),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");
    expect(container.textContent).not.toContain("anomaly signal");
  });

  it("Ignore last hour chip appears when signals exist and is not suppressed", async () => {
    installMcpApi({
      getAuditStats: vi.fn().mockResolvedValue({
        auth401Count: 0,
        anomalySignals: [
          {
            id: "latency-drift:1",
            kind: "latency-drift",
            toolId: "slow.tool",
            severity: "danger",
            timestamp: Date.now() - 3_600_001,
            recordIds: ["r1"],
            zScore: 4.2,
            durationMs: 5000,
            baselineMedianMs: 10,
          },
        ],
        anomalySuppressed: false,
        anomalyRecordFloor: 50,
      }),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "Ignore last hour");
  });

  it("anomaly signals do not trigger notify()", async () => {
    installMcpApi({
      getAuditStats: vi.fn().mockResolvedValue({
        auth401Count: 0,
        anomalySignals: [
          {
            id: "latency-drift:1",
            kind: "latency-drift",
            toolId: "slow.tool",
            severity: "danger",
            timestamp: Date.now(),
            recordIds: ["r1"],
            zScore: 4.2,
            durationMs: 5000,
            baselineMedianMs: 10,
          },
        ],
        anomalySuppressed: false,
        anomalyRecordFloor: 50,
      }),
    });

    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "anomaly signal");
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("copy config and copy API key have independent Copied! timeouts", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByRole("button", { name: /copy mcp config/i }));
    await waitFor(() => {
      expect(screen.getByText("Copied!")).toBeTruthy();
    });

    // Copy API key — both buttons show Copied! independently
    fireEvent.click(screen.getByLabelText("Copy API key"));
    await waitFor(() => {
      const copiedEls = screen.getAllByText("Copied!");
      expect(copiedEls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("external clients (#8778)", () => {
    const bearer = {
      tokenHash: "a".repeat(64),
      token4LastChars: "wxyz",
      userAgent: "Claude Code/1.2.3",
      lastActiveAt: Date.now() - 5000,
      requestsSinceLaunch: 3,
    };

    it("hides the external-clients row when no bearers are connected", async () => {
      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "API key active");
      expect(container.textContent).not.toContain("External clients");
    });

    it("shows connected clients and disconnects one on demand", async () => {
      const disconnectBearer = vi
        .fn()
        .mockResolvedValue({ tokenHash: bearer.tokenHash, disconnected: true });
      const listActiveBearers = vi.fn().mockResolvedValueOnce([bearer]).mockResolvedValue([]);
      installMcpApi({ listActiveBearers, disconnectBearer });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "External clients (1)");

      fireEvent.click(screen.getByRole("button", { name: /external clients/i }));
      await waitFor(() => {
        expect(container.textContent).toContain("Claude Code/1.2.3");
      });

      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      await waitFor(() => {
        expect(disconnectBearer).toHaveBeenCalledWith(bearer.tokenHash);
      });
      await waitFor(() => {
        expect(container.textContent).not.toContain("External clients");
      });
    });

    it("populates the clients row when a runtime-state change fires after mount", async () => {
      let runtimeCb: ((snapshot: unknown) => void) | undefined;
      const onRuntimeStateChanged = vi.fn((cb: (snapshot: unknown) => void) => {
        runtimeCb = cb;
        return vi.fn();
      });
      const listActiveBearers = vi
        .fn()
        .mockResolvedValueOnce([]) // initial mount: nothing connected
        .mockResolvedValue([bearer]); // after the push: one client
      installMcpApi({ onRuntimeStateChanged, listActiveBearers });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "API key active");
      expect(container.textContent).not.toContain("External clients");

      runtimeCb?.({ enabled: true, state: "ready", port: 9020, lastError: null });
      await waitForContent(container, "External clients (1)");
    });

    it("shows the assistant-attribution pill only when daintreeControl is on", async () => {
      installMcpApi({}, { getSettings: vi.fn().mockResolvedValue({ daintreeControl: true }) });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "Kept alive by Daintree Assistant");
    });

    it("omits the attribution pill when daintreeControl is off", async () => {
      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "API key active");
      expect(container.textContent).not.toContain("Kept alive by Daintree Assistant");
    });
  });

  describe("internal connections (#10036)", () => {
    const helpBearer = {
      userAgent: "Daintree Assistant/1.0",
      lastActiveAt: Date.now() - 5000,
      requestsSinceLaunch: 4,
      sessionCount: 2,
    };

    it("hides the internal-connections row when no internal bearer is connected", async () => {
      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "API key active");
      expect(container.textContent).not.toContain("Internal connections");
    });

    it("shows the internal-connection row read-only, with no disconnect control", async () => {
      const listHelpSessionBearers = vi.fn().mockResolvedValue([helpBearer]);
      installMcpApi({ listHelpSessionBearers });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "Internal connections (1)");

      fireEvent.click(screen.getByRole("button", { name: /internal connections/i }));
      await waitFor(() => {
        expect(container.textContent).toContain("Daintree Assistant/1.0");
      });
      // Session and request counts are surfaced...
      expect(container.textContent).toContain("2 sessions");
      expect(container.textContent).toContain("4 requests");
      // ...but there is no disconnect affordance for an internal connection.
      expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    });

    it("keeps the internal row read-only while the external row stays disconnectable (#9151)", async () => {
      const externalBearer = {
        tokenHash: "b".repeat(64),
        token4LastChars: "abcd",
        userAgent: "Cursor/0.42",
        lastActiveAt: Date.now() - 1000,
        requestsSinceLaunch: 7,
      };
      const listActiveBearers = vi.fn().mockResolvedValue([externalBearer]);
      const listHelpSessionBearers = vi.fn().mockResolvedValue([helpBearer]);
      installMcpApi({ listActiveBearers, listHelpSessionBearers });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "External clients (1)");
      await waitForContent(container, "Internal connections (1)");

      // Expand both sections so every row is rendered.
      fireEvent.click(screen.getByRole("button", { name: /external clients/i }));
      fireEvent.click(screen.getByRole("button", { name: /internal connections/i }));
      await waitFor(() => {
        expect(container.textContent).toContain("Cursor/0.42");
        expect(container.textContent).toContain("Daintree Assistant/1.0");
      });

      // Exactly one Disconnect button exists — the external row's. The internal
      // row never offers one, even when both sections are visible at once.
      expect(screen.getAllByRole("button", { name: "Disconnect" })).toHaveLength(1);
    });

    it("populates the internal-connections row when a runtime-state change fires after mount", async () => {
      let runtimeCb: ((snapshot: unknown) => void) | undefined;
      const onRuntimeStateChanged = vi.fn((cb: (snapshot: unknown) => void) => {
        runtimeCb = cb;
        return vi.fn();
      });
      const listHelpSessionBearers = vi
        .fn()
        .mockResolvedValueOnce([]) // initial mount: nothing connected
        .mockResolvedValue([helpBearer]); // after the push: connected
      installMcpApi({ onRuntimeStateChanged, listHelpSessionBearers });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "API key active");
      expect(container.textContent).not.toContain("Internal connections");

      runtimeCb?.({ enabled: true, state: "ready", port: 9020, lastError: null });
      await waitForContent(container, "Internal connections (1)");
    });
  });

  describe("Connection section runtime state", () => {
    it("renders the running tree, URL block, and copy button when state is ready", async () => {
      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "API key active");
      expect(container.textContent).toContain("Running on port 9020");
      expect(container.textContent).toContain("http://127.0.0.1:9020/sse");
      expect(screen.getByRole("button", { name: /copy mcp config/i })).toBeTruthy();
    });

    it("uses the runtime snapshot port when it diverges from the slower getStatus refetch", async () => {
      // Regression: the ready branch must read the port from the runtime
      // snapshot, not from the persisted-config `status`, so a push that
      // binds the port before `getStatus()` resolves still renders the URL.
      installMcpApi({
        getRuntimeState: vi.fn().mockResolvedValue({
          enabled: true,
          state: "ready",
          port: 9020,
          lastError: null,
        }),
        getStatus: vi.fn().mockResolvedValue({
          enabled: true,
          port: null,
          configuredPort: 9020,
          apiKey: "dnt-key-abc123",
        }),
      });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "API key active");
      expect(container.textContent).toContain("Running on port 9020");
      expect(container.textContent).toContain("http://127.0.0.1:9020/sse");
    });

    it("renders the starting copy and hides the URL block when state is starting", async () => {
      installMcpApi({
        getRuntimeState: vi.fn().mockResolvedValue({
          enabled: true,
          state: "starting",
          port: null,
          lastError: null,
        }),
      });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "API key active");
      expect(container.textContent).toContain("Server is starting…");
      expect(container.textContent).not.toContain("http://127.0.0.1");
      expect(container.textContent).not.toContain("Copy MCP config");
    });

    it("renders the failed banner with lastError when state is failed and an error is set", async () => {
      installMcpApi({
        getRuntimeState: vi.fn().mockResolvedValue({
          enabled: true,
          state: "failed",
          port: null,
          lastError: "EADDRINUSE: port 45454 already in use",
        }),
      });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "MCP server failed to start");
      expect(container.textContent).toContain("EADDRINUSE: port 45454 already in use");
      expect(container.textContent).not.toContain("Server is starting…");
      expect(container.textContent).not.toContain("Copy MCP config");
    });

    it("renders the failed banner with fallback copy when state is failed and lastError is null", async () => {
      installMcpApi({
        getRuntimeState: vi.fn().mockResolvedValue({
          enabled: true,
          state: "failed",
          port: null,
          lastError: null,
        }),
      });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "MCP server failed to start");
      expect(container.textContent).toContain("Check the logs for details.");
      expect(container.textContent).not.toContain("Server is starting…");
    });

    it("transitions the Connection section from ready to failed when a runtime push fires", async () => {
      let runtimeCb: ((snapshot: unknown) => void) | undefined;
      const onRuntimeStateChanged = vi.fn((cb: (snapshot: unknown) => void) => {
        runtimeCb = cb;
        return vi.fn();
      });
      installMcpApi({
        onRuntimeStateChanged,
        getRuntimeState: vi.fn().mockResolvedValue({
          enabled: true,
          state: "ready",
          port: 9020,
          lastError: null,
        }),
        getStatus: vi.fn().mockResolvedValue({
          enabled: true,
          port: null,
          configuredPort: 9020,
          apiKey: "dnt-key-abc123",
        }),
      });

      const { container } = render(
        <SettingsValidationProvider>
          <McpServerSettingsTab />
        </SettingsValidationProvider>
      );
      await waitForContent(container, "API key active");
      expect(container.textContent).toContain("Running on port");

      runtimeCb?.({
        enabled: true,
        state: "failed",
        port: null,
        lastError: "listen EACCES: permission denied",
      });

      await waitForContent(container, "MCP server failed to start");
      expect(container.textContent).toContain("listen EACCES: permission denied");
      expect(container.textContent).not.toContain("Running on port");
    });
  });
});
