// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/components/icons", () => ({
  DaintreeIcon: ({ className }: { className?: string }) => (
    <span data-testid="daintree-icon" className={className} />
  ),
  McpServerIcon: ({ className }: { className?: string }) => (
    <span data-testid="mcp-icon" className={className} />
  ),
}));

interface SettingsSelectStubOption {
  value: string;
  label: string;
}

vi.mock("../SettingsSelect", () => ({
  SettingsSelect: ({
    label,
    value,
    onValueChange,
    options,
  }: {
    label: string;
    value: string;
    onValueChange: (v: string) => void;
    options: SettingsSelectStubOption[];
  }) => (
    <label>
      {label}
      <select aria-label={label} value={value} onChange={(e) => onValueChange(e.target.value)}>
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
  setPreferredAgent: vi.fn(),
};

vi.mock("@/store/helpPanelStore", () => {
  const store = (selector?: (s: typeof helpPanelState) => unknown) =>
    selector ? selector(helpPanelState) : helpPanelState;
  store.getState = () => helpPanelState;
  return {
    useHelpPanelStore: store,
    HELP_PANEL_MIN_WIDTH: 320,
    HELP_PANEL_MAX_WIDTH: 800,
    HELP_PANEL_DEFAULT_WIDTH: 380,
  };
});

vi.mock("@/config/agents", () => ({
  getAssistantSupportedAgentIds: () => ["claude"],
  getAgentConfig: (id: string) => (id === "claude" ? { name: "Claude Code" } : undefined),
}));

import { DaintreeAssistantSettingsTab } from "../DaintreeAssistantSettingsTab";

const writeText = vi.fn().mockResolvedValue(undefined);

interface HelpAssistantApi {
  getSettings: ReturnType<typeof vi.fn>;
  setSettings: ReturnType<typeof vi.fn>;
}

interface McpServerApi {
  getStatus: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  rotateApiKey: ReturnType<typeof vi.fn>;
  getConfigSnippet: ReturnType<typeof vi.fn>;
  onRuntimeStateChanged: ReturnType<typeof vi.fn>;
}

function installApi(
  helpAssistant: Partial<HelpAssistantApi> = {},
  mcpServer: Partial<McpServerApi> = {}
) {
  const helpDefaults: HelpAssistantApi = {
    getSettings: vi.fn().mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      skipPermissions: false,
      auditRetention: 7,
      customArgs: "",
    }),
    setSettings: vi.fn().mockResolvedValue(undefined),
  };
  const mcpDefaults: McpServerApi = {
    getStatus: vi.fn().mockResolvedValue({
      enabled: true,
      port: 45454,
      configuredPort: 45454,
      apiKey: "dnt-key-abc",
    }),
    setEnabled: vi.fn().mockResolvedValue({
      enabled: true,
      port: 45454,
      configuredPort: 45454,
      apiKey: "dnt-key-abc",
    }),
    rotateApiKey: vi.fn().mockResolvedValue("dnt-key-new"),
    getConfigSnippet: vi.fn().mockResolvedValue('{ "url": "http://127.0.0.1:45454/sse" }'),
    onRuntimeStateChanged: vi.fn(() => () => {}),
  };
  window.electron = {
    helpAssistant: { ...helpDefaults, ...helpAssistant },
    mcpServer: { ...mcpDefaults, ...mcpServer },
  } as unknown as typeof window.electron;
}

describe("DaintreeAssistantSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helpPanelState.preferredAgentId = null;
    helpPanelState.setPreferredAgent = vi.fn();
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
    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "Search documentation");

    expect(window.electron.helpAssistant.getSettings).toHaveBeenCalledTimes(1);
    expect(window.electron.mcpServer.getStatus).toHaveBeenCalledTimes(1);
  });

  it("toggling doc search persists docSearch=false", async () => {
    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "Search documentation");

    const toggle = screen.getByLabelText("Allow the assistant to search Daintree documentation");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(window.electron.helpAssistant.setSettings).toHaveBeenCalledWith({ docSearch: false });
    });
  });

  it("turning on skip permissions reveals the inline warning copy", async () => {
    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "Skip permission prompts");

    expect(container.textContent).not.toContain("becomes the only safeguard");

    const toggle = screen.getByLabelText("Skip permission prompts during help sessions");
    fireEvent.click(toggle);

    await waitForContent(container, "becomes the only safeguard");
    expect(window.electron.helpAssistant.setSettings).toHaveBeenCalledWith({
      skipPermissions: true,
    });
  });

  it("rotate key calls mcpServer.rotateApiKey", async () => {
    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "Rotate MCP key");

    fireEvent.click(screen.getByRole("button", { name: /rotate mcp key/i }));

    await waitFor(() => {
      expect(window.electron.mcpServer.rotateApiKey).toHaveBeenCalledTimes(1);
    });
  });

  it("copy MCP config writes the snippet to the clipboard and shows confirmation", async () => {
    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "Copy MCP config");

    fireEvent.click(screen.getByRole("button", { name: /copy mcp config/i }));

    await waitFor(() => {
      expect(window.electron.mcpServer.getConfigSnippet).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith('{ "url": "http://127.0.0.1:45454/sse" }');
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
      }
    );

    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "MCP server is off");

    expect(screen.queryByRole("button", { name: /rotate mcp key/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /copy mcp config/i })).toBeNull();
  });

  it("does not render a Preferred model section", async () => {
    const { container } = render(<DaintreeAssistantSettingsTab />);
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
          skipPermissions: false,
          auditRetention: 7,
        }),
      },
      { getStatus: vi.fn().mockRejectedValue(new Error("ipc down")) }
    );

    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "Search documentation");

    const docSearchToggle = screen.getByLabelText(
      "Allow the assistant to search Daintree documentation"
    );
    expect(docSearchToggle.getAttribute("data-state")).toBe("unchecked");
    expect(container.textContent).toContain("Couldn't load MCP status");
  });

  it("surfaces a setSettings IPC failure as an inline error banner", async () => {
    installApi({
      setSettings: vi.fn().mockRejectedValue(new Error("disk full")),
    });

    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "Search documentation");

    fireEvent.click(screen.getByLabelText("Allow the assistant to search Daintree documentation"));

    await waitForContent(container, "disk full");
  });

  it("does not flash 'Copied' when clipboard.writeText rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("permission denied"));

    const { container } = render(<DaintreeAssistantSettingsTab />);
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

    const { container } = render(<DaintreeAssistantSettingsTab />);
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
    const { container } = render(<DaintreeAssistantSettingsTab />);
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
    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "Agent");

    const select = screen.getByRole("combobox", { name: "Agent" }) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.label);
    expect(labels).toContain("Claude Code");
  });

  it("calls helpPanelStore.setPreferredAgent when the agent dropdown changes", async () => {
    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "Agent");

    const select = screen.getByRole("combobox", { name: "Agent" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "claude" } });

    expect(helpPanelState.setPreferredAgent).toHaveBeenCalledWith("claude");
  });

  it("loads customArgs from the IPC settings into the input", async () => {
    installApi({
      getSettings: vi.fn().mockResolvedValue({
        docSearch: true,
        daintreeControl: true,
        skipPermissions: false,
        auditRetention: 7,
        customArgs: "--model sonnet",
      }),
    });

    const { container } = render(<DaintreeAssistantSettingsTab />);
    await waitForContent(container, "Custom CLI args");

    const input = screen.getByLabelText("Custom CLI args") as HTMLInputElement;
    expect(input.value).toBe("--model sonnet");
  });

  it("persists customArgs via setSettings on input change", async () => {
    const { container } = render(<DaintreeAssistantSettingsTab />);
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
        skipPermissions: false,
        auditRetention: 7,
        customArgs: "--model sonnet",
      }),
    });

    const { container } = render(<DaintreeAssistantSettingsTab />);
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
