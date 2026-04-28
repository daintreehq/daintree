// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServerSettingsTab } from "../McpServerSettingsTab";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/components/icons", () => ({
  McpServerIcon: () => null,
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
    generateApiKey: vi.fn().mockResolvedValue("dnt-key-new456"),
    setApiKey: vi.fn().mockResolvedValue({
      enabled: true,
      port: 9020,
      configuredPort: 9020,
      apiKey: "",
    }),
    ...overrides,
  };
}

const writeText = vi.fn().mockResolvedValue(undefined);

describe("McpServerSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    window.electron = {
      mcpServer: createMcpApi(),
    } as unknown as typeof window.electron;
  });

  const waitForContent = (container: HTMLElement, text: string) =>
    waitFor(
      () => {
        expect(container.textContent).toContain(text);
      },
      { timeout: 5000 }
    );

  it("renders API key in a non-input display element", async () => {
    const { container } = render(<McpServerSettingsTab />);
    await waitForContent(container, "API key active");

    const displayArea = container.querySelector(".bg-surface-disabled");
    expect(displayArea).toBeTruthy();
    expect(displayArea?.tagName).toBe("DIV");

    const inputs = container.querySelectorAll("input[readonly]");
    expect(inputs.length).toBe(0);
  });

  it("shows masked bullets by default, reveals key on toggle", async () => {
    const { container } = render(<McpServerSettingsTab />);
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
    const { container } = render(<McpServerSettingsTab />);
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByLabelText("Copy API key"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("dnt-key-abc123");
    });
  });

  it("copy button shows Copied! feedback", async () => {
    const { container } = render(<McpServerSettingsTab />);
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByLabelText("Copy API key"));

    await waitFor(() => {
      expect(screen.getByText("Copied!")).toBeTruthy();
    });
    expect(writeText).toHaveBeenCalledWith("dnt-key-abc123");
  });

  it("Regenerate calls generateApiKey", async () => {
    const { container } = render(<McpServerSettingsTab />);
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByTitle("Regenerate API key"));
    await waitFor(() => {
      expect(window.electron.mcpServer.generateApiKey).toHaveBeenCalled();
    });
  });

  it("Remove clears the key and shows Generate API Key button", async () => {
    const { container } = render(<McpServerSettingsTab />);
    await waitForContent(container, "API key active");

    fireEvent.click(screen.getByText("Remove"));
    await waitFor(() => {
      expect(window.electron.mcpServer.setApiKey).toHaveBeenCalledWith("");
      expect(screen.getByText("Generate API Key")).toBeTruthy();
    });
  });

  it("routes IPC failure to inbox via low-priority notify and inline error", async () => {
    window.electron = {
      mcpServer: createMcpApi({
        getStatus: vi.fn().mockRejectedValue(new Error("IPC down")),
      }),
    } as unknown as typeof window.electron;

    const { container } = render(<McpServerSettingsTab />);

    await waitForContent(container, "IPC down");

    expect(mockedNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        priority: "low",
        title: "MCP status failed",
      })
    );
    expect(mockedLogError).toHaveBeenCalledWith("Failed to load MCP status", expect.any(Error));
  });

  it("routes toggle IPC failure to inbox while keeping inline error", async () => {
    window.electron = {
      mcpServer: createMcpApi({
        setEnabled: vi.fn().mockRejectedValue(new Error("toggle failed")),
      }),
    } as unknown as typeof window.electron;

    const { container } = render(<McpServerSettingsTab />);
    await waitForContent(container, "MCP Server");

    fireEvent.click(screen.getByLabelText("Enable MCP server"));

    await waitForContent(container, "toggle failed");
    expect(mockedNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        priority: "low",
        title: "MCP server update failed",
      })
    );
    expect(mockedLogError).toHaveBeenCalledWith("Failed to update MCP server", expect.any(Error));
  });
});
