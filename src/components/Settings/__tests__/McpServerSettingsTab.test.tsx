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
    setEnabled: vi.fn(),
    setPort: vi.fn(),
    getConfigSnippet: vi.fn().mockResolvedValue("http://127.0.0.1:9020/sse"),
    rotateApiKey: vi.fn().mockResolvedValue("dnt-key-rotated789"),
    getAuditRecords: vi.fn().mockResolvedValue([]),
    getTurnOutcomeRecords: vi.fn().mockResolvedValue([]),
    getAuditConfig: vi.fn().mockResolvedValue({ enabled: true, maxRecords: 500 }),
    clearAuditLog: vi.fn().mockResolvedValue(undefined),
    setAuditEnabled: vi.fn().mockResolvedValue({ enabled: true, maxRecords: 500 }),
    setAuditMaxRecords: vi.fn().mockResolvedValue({ enabled: true, maxRecords: 500 }),
    onRuntimeStateChanged: vi.fn().mockReturnValue(vi.fn()),
    ...overrides,
  };
}

const writeText = vi.fn().mockResolvedValue(undefined);

function installMcpApi(overrides: Partial<typeof window.electron.mcpServer> = {}) {
  window.electron = {
    mcpServer: createMcpApi(overrides),
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
    expect(confirmButton.disabled).toBe(true);

    const typedInput = screen.getByLabelText(/^Type .* to confirm$/i) as HTMLInputElement;
    fireEvent.change(typedInput, { target: { value: "c123" } });
    expect(confirmButton.disabled).toBe(false);

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

    fireEvent.change(screen.getByLabelText(/^Type .* to confirm$/i), {
      target: { value: "c123" },
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

    fireEvent.change(screen.getByLabelText(/^Type .* to confirm$/i), {
      target: { value: "c123" },
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
      getAuditRecords: vi.fn().mockResolvedValue([
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

    fireEvent.click(screen.getByRole("button", { name: /^clear log$/i }));

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
      getAuditRecords: vi.fn().mockResolvedValue([
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

    fireEvent.click(screen.getByRole("button", { name: /^clear log$/i }));
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
      getAuditRecords: vi.fn().mockResolvedValue([
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

    fireEvent.click(screen.getByRole("button", { name: /^clear log$/i }));
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
      getAuditRecords: vi.fn().mockResolvedValue([
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
      getAuditRecords: vi.fn().mockResolvedValue([
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
      getAuditRecords: vi.fn().mockResolvedValue([
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
      getAuditRecords: vi.fn().mockResolvedValue([
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

  it("subscribes to runtime state changes on mount", async () => {
    const unsub = vi.fn();
    const onRuntimeStateChanged = vi.fn().mockReturnValue(unsub);

    installMcpApi({ onRuntimeStateChanged });

    render(
      <SettingsValidationProvider>
        <McpServerSettingsTab />
      </SettingsValidationProvider>
    );

    await waitFor(() => {
      expect(onRuntimeStateChanged).toHaveBeenCalledTimes(1);
    });
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
});
