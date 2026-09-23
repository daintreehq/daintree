// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { dispatchEscape, registerEscape } from "@/lib/escapeStack";
import { createContext, use } from "react";
import type { ReactNode } from "react";
import { PluginSettingsForm } from "../PluginSettingsForm";
import type {
  LoadedPluginInfo,
  PluginSettingsUiValues,
  SettingDefinition,
} from "@shared/types/plugin";

/** Build a complete settings-UI payload; overrides fill in only what a test cares about. */
function uiValues(over: Partial<PluginSettingsUiValues> = {}): PluginSettingsUiValues {
  return {
    values: {},
    secretsSet: [],
    secretsPlaintext: [],
    secretTier: "keychain",
    ...over,
  };
}

let currentProjectId: string | null = null;

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: currentProjectId ? { id: currentProjectId } : null }),
}));

// The real Select lazy-loads Radix. This stand-in keeps the trigger's own props (its
// label wiring and disabled state) and lets a test pick an option with a click.
vi.mock("@/components/ui/select", () => {
  interface Ctx {
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }
  const SelectCtx = createContext<Ctx | null>(null);
  return {
    Select: ({ children, ...ctx }: Ctx & { children: ReactNode }) => (
      <SelectCtx value={ctx}>{children}</SelectCtx>
    ),
    SelectTrigger: ({ children, ...props }: { children: ReactNode }) => {
      const ctx = use(SelectCtx)!;
      return (
        <button
          type="button"
          role="combobox"
          disabled={ctx.disabled}
          aria-expanded={ctx.open === true}
          onClick={() => ctx.onOpenChange?.(true)}
          {...props}
        >
          {children}
        </button>
      );
    },
    SelectValue: ({ placeholder }: { placeholder?: string }) => {
      const ctx = use(SelectCtx)!;
      return <span>{ctx.value || placeholder}</span>;
    },
    SelectContent: ({ children }: { children: ReactNode }) => <div role="listbox">{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const ctx = use(SelectCtx)!;
      return (
        <div
          role="option"
          aria-selected={ctx.value === value}
          onClick={() => ctx.onValueChange(value)}
        >
          {children}
        </div>
      );
    },
  };
});

const pluginApi = {
  getSettingValues: vi.fn(),
  setSettingValue: vi.fn().mockResolvedValue(undefined),
  deleteSettingValue: vi.fn().mockResolvedValue(undefined),
  revealSecretSetting: vi.fn(),
  pickPath: vi.fn(),
  pathExists: vi.fn(),
};

function makePlugin(settings: SettingDefinition[]): LoadedPluginInfo {
  return {
    manifest: {
      name: "acme.test",
      version: "1.0.0",
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        keybindings: [],
        contextMenus: [],
        commands: [],
        views: [],
        mcpServers: [],
        skills: [],
        forgeProviders: [],
        fileDecorationProviders: [],
        fileEditors: [],
        agents: [],
        settings,
      },
    },
    instanceId: "acme.test",
    dir: "/tmp/acme.test",
    loadedAt: 0,
    isBuiltin: false,
    source: "sideload",
    installedAt: 0,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    disabled: false,
    updateAvailable: null,
    devMode: false,
  } as unknown as LoadedPluginInfo;
}

beforeEach(() => {
  currentProjectId = null;
  vi.clearAllMocks();
  pluginApi.setSettingValue.mockResolvedValue(undefined);
  pluginApi.deleteSettingValue.mockResolvedValue(undefined);
  pluginApi.getSettingValues.mockResolvedValue(uiValues());
  pluginApi.pickPath.mockResolvedValue(null);
  pluginApi.pathExists.mockResolvedValue(true);
  (window as unknown as { electron: unknown }).electron = { plugin: pluginApi };
});

afterEach(() => {
  cleanup();
});

describe("PluginSettingsForm", () => {
  it("renders field chrome immediately, before values resolve", () => {
    let resolve!: (v: PluginSettingsUiValues) => void;
    pluginApi.getSettingValues.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "apiKey", type: "string", label: "API key" }])}
      />
    );
    // Label + control paint synchronously from the manifest; the input is
    // disabled until the bridge call resolves.
    const input = screen.getByLabelText("API key") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.disabled).toBe(true);
    resolve(uiValues());
  });

  it("populates a stored string value and writes it on blur", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { apiKey: "stored" } }));
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "apiKey", type: "string", label: "API key" }])}
      />
    );

    const input = (await screen.findByLabelText("API key")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("stored"));

    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(pluginApi.setSettingValue).toHaveBeenCalledWith(
        "acme.test",
        "apiKey",
        "changed",
        "user",
        null
      )
    );
  });

  it("shows the declared default when no value is stored", async () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "host", type: "string", label: "Host", default: "localhost" }])}
      />
    );
    const input = (await screen.findByLabelText("Host")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("localhost"));
  });

  it("writes a boolean on toggle", async () => {
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "flag", type: "boolean", label: "Flag" }])} />
    );
    const toggle = (await screen.findByRole("switch", { name: "Flag" })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(pluginApi.setSettingValue).toHaveBeenCalledWith(
        "acme.test",
        "flag",
        true,
        "user",
        null
      )
    );
  });

  it("writes an enum on change", async () => {
    // Six options: past the segmented-control limit, so this is the select path.
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "mode", type: "enum", label: "Mode", options: ["a", "b", "c", "d", "e", "f"] },
        ])}
      />
    );
    const select = (await screen.findByRole("combobox", { name: "Mode" })) as HTMLButtonElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    // Unset: the placeholder, not a silently adopted first option.
    expect(select.textContent).toBe("Select…");
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "b" }));
    await waitFor(() =>
      expect(pluginApi.setSettingValue).toHaveBeenCalledWith("acme.test", "mode", "b", "user", null)
    );
  });

  it("closes an open enum list, and only the list, on Escape", async () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "mode", type: "enum", label: "Mode", options: ["Only the essentials", "Everything"] }])}
      />
    );
    const select = (await screen.findByRole("combobox", { name: "Mode" })) as HTMLButtonElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    // A surface underneath that also listens for Escape — the plugin manager.
    const outer = vi.fn();
    const outerEntry = registerEscape(outer);
    try {
      fireEvent.click(select);
      await waitFor(() => expect(select.getAttribute("aria-expanded")).toBe("true"));
      act(() => {
        dispatchEscape();
      });
      await waitFor(() => expect(select.getAttribute("aria-expanded")).toBe("false"));
      expect(outer).not.toHaveBeenCalled();
    } finally {
      outerEntry.unregister();
    }
  });

  it("drops an open enum list and its Escape claim when the field is disabled", async () => {
    let resolveWrite: () => void = () => {};
    vi.mocked(pluginApi.setSettingValue).mockImplementation(
      () => new Promise<void>((resolve) => (resolveWrite = resolve))
    );
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "mode", type: "enum", label: "Mode", options: ["Only the essentials", "Everything"] }])}
      />
    );
    const select = (await screen.findByRole("combobox", { name: "Mode" })) as HTMLButtonElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.click(select);
    await waitFor(() => expect(select.getAttribute("aria-expanded")).toBe("true"));
    // Picking an option starts a save, which disables the field.
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Everything" }));
    await waitFor(() => expect(select.disabled).toBe(true));
    expect(select.getAttribute("aria-expanded")).toBe("false");
    const outer = vi.fn();
    const outerEntry = registerEscape(outer);
    try {
      act(() => {
        dispatchEscape();
      });
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      outerEntry.unregister();
      await act(async () => resolveWrite());
    }
  });

  it("renders a short enum as a segmented control, and a long one as a select", async () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "size", type: "enum", label: "Size", options: ["Small", "Large"] },
          {
            id: "level",
            type: "enum",
            label: "Level",
            options: ["Only the essentials", "Everything"],
          },
        ])}
      />
    );
    // The rule, not a fixed option count: few options with short labels fit a rail as
    // segments; a long label anywhere forces the select.
    expect(await screen.findByRole("radiogroup", { name: "Size" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Size" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Level" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Level" })).toBeNull();
  });

  it("puts a switch back when its write fails", async () => {
    pluginApi.setSettingValue.mockRejectedValue(new Error("disk full"));
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "flag", type: "boolean", label: "Flag" }])} />
    );
    const toggle = (await screen.findByRole("switch", { name: "Flag" })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    // Showing the value it couldn't save would read as applied.
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(await screen.findByText("disk full")).toBeTruthy();
  });

  it("puts an enum back when its write fails", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { size: "Small" } }));
    pluginApi.setSettingValue.mockRejectedValue(new Error("disk full"));
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "size", type: "enum", label: "Size", options: ["Small", "Large"] },
        ])}
      />
    );
    const large = (await screen.findByRole("radio", { name: "Large" })) as HTMLButtonElement;
    await waitFor(() => expect(large.disabled).toBe(false));
    fireEvent.click(large);
    await screen.findByText("disk full");
    expect(screen.getByRole("radio", { name: "Small" }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps fields uneditable after a failed read, and Retry reads again", async () => {
    pluginApi.getSettingValues.mockRejectedValueOnce(new Error("EACCES"));
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "host", type: "string", label: "Host", default: "localhost" }])}
      />
    );
    // A failed read must not look like "nothing stored": no default filled in, no edit.
    const alert = await screen.findByRole("alert");
    const input = screen.getByLabelText("Host") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("");

    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { host: "example.test" } }));
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(input.value).toBe("example.test"));
    expect(input.disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces an inline error for invalid JSON and does not write", async () => {
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "cfg", type: "json", label: "Config" }])} />
    );
    const textarea = (await screen.findByLabelText("Config")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.disabled).toBe(false));
    fireEvent.change(textarea, { target: { value: "{ not json" } });
    fireEvent.blur(textarea);
    expect(await screen.findByText("Enter valid JSON")).toBeTruthy();
    expect(pluginApi.setSettingValue).not.toHaveBeenCalled();
  });

  it("never shows a secret value until revealed, then re-masks on blur", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ secretsSet: ["token"] }));
    pluginApi.revealSecretSetting.mockResolvedValue("sekret");
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "token", type: "secret", label: "Token" }])} />
    );

    const input = (await screen.findByLabelText("Token")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    // Bulk load never carried the secret value.
    expect(input.value).toBe("");
    expect(input.type).toBe("password");

    fireEvent.click(await screen.findByRole("button", { name: "Reveal Token" }));
    await waitFor(() => expect(input.value).toBe("sekret"));
    expect(input.type).toBe("text");

    fireEvent.blur(input);
    await waitFor(() =>
      expect(pluginApi.setSettingValue).toHaveBeenCalledWith(
        "acme.test",
        "token",
        "sekret",
        "user",
        null
      )
    );
    // Re-masked: value cleared from the DOM.
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("discloses the OS-keychain tier under a secret field", async () => {
    pluginApi.getSettingValues.mockResolvedValue(
      uiValues({ secretsSet: ["token"], secretTier: "keychain" })
    );
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "token", type: "secret", label: "Token" }])} />
    );
    await screen.findByLabelText("Token");
    expect(await screen.findByText("Stored in OS keychain")).toBeTruthy();
  });

  it("discloses that secrets can't be saved when no keychain is available", async () => {
    pluginApi.getSettingValues.mockResolvedValue(
      uiValues({ secretsSet: ["token"], secretTier: "unavailable", secretsPlaintext: ["token"] })
    );
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "token", type: "secret", label: "Token" }])} />
    );
    await screen.findByLabelText("Token");
    expect(await screen.findByText(/Secure storage unavailable/)).toBeTruthy();
  });

  it("keeps a refused secret in the field beside the error instead of marking it saved", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ secretTier: "unavailable" }));
    pluginApi.setSettingValue.mockRejectedValue(
      new Error('Secure storage is unavailable on this device, so the secret "token" wasn\'t saved')
    );
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "token", type: "secret", label: "Token" }])} />
    );

    const input = (await screen.findByLabelText("Token")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "sk-typed" } });
    fireEvent.blur(input);

    expect(await screen.findByText(/wasn't saved/)).toBeTruthy();
    expect(input.value).toBe("sk-typed");
  });

  it("nudges re-saving a secret still in plaintext while a keychain is now available", async () => {
    pluginApi.getSettingValues.mockResolvedValue(
      uiValues({ secretsSet: ["token"], secretTier: "keychain", secretsPlaintext: ["token"] })
    );
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "token", type: "secret", label: "Token" }])} />
    );
    await screen.findByLabelText("Token");
    expect(await screen.findByText(/re-save to move it into the OS keychain/)).toBeTruthy();
  });

  it("marks a stored value as modified and resets it through the row's reset", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { host: "remote" } }));
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "host", type: "string", label: "Host", default: "localhost" }])}
      />
    );
    const input = (await screen.findByLabelText("Host")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("remote"));

    fireEvent.click(screen.getByRole("button", { name: "Reset Host to default" }));
    await waitFor(() =>
      expect(pluginApi.deleteSettingValue).toHaveBeenCalledWith("acme.test", "host", "user", null)
    );
    await waitFor(() => expect(input.value).toBe("localhost"));
    // Back at the default: nothing left to reset.
    expect(screen.queryByRole("button", { name: "Reset Host to default" })).toBeNull();
  });

  it("shows no reset for a field still at its default", async () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "host", type: "string", label: "Host", default: "localhost" }])}
      />
    );
    const input = (await screen.findByLabelText("Host")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Reset Host to default" })).toBeNull();

    fireEvent.change(input, { target: { value: "elsewhere" } });
    fireEvent.blur(input);
    expect(await screen.findByRole("button", { name: "Reset Host to default" })).toBeTruthy();
  });

  it("describes a field by its manifest description and error", async () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "cfg", type: "json", label: "Config", description: "Extra options" },
        ])}
      />
    );
    const textarea = (await screen.findByLabelText("Config")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.disabled).toBe(false));
    fireEvent.change(textarea, { target: { value: "{" } });
    fireEvent.blur(textarea);
    await screen.findByText("Enter valid JSON");
    const described = (textarea.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Enter valid JSON", "Extra options"]);
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
  });

  it("renders a scope badge per field", async () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "u", type: "string", label: "U" },
          { id: "p", type: "string", label: "P", scope: "project" },
          { id: "l", type: "string", label: "L", scope: "local" },
        ])}
      />
    );
    // Named for what a change reaches: one project, or every project.
    expect(await screen.findByText("All projects")).toBeTruthy();
    expect(screen.getByText("This project")).toBeTruthy();
    expect(screen.getByText("This project, this machine")).toBeTruthy();
  });

  it("disables project-scoped fields when no project is active", async () => {
    currentProjectId = null;
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "p", type: "string", label: "P", scope: "project" }])}
      />
    );
    const input = (await screen.findByLabelText("P")) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText("Open a project to edit this setting")).toBeTruthy();
  });

  it("renders a directory field as a read-only input plus a Browse button", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { store: "/Users/x/notes" } }));
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "store", type: "directory", label: "Storage folder" }])}
      />
    );
    const input = (await screen.findByLabelText("Storage folder")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("/Users/x/notes"));
    expect(input.readOnly).toBe(true);
    expect(screen.getByRole("button", { name: "Browse" })).toBeTruthy();
  });

  it("writes the chosen directory path through setSettingValue on Browse", async () => {
    pluginApi.pickPath.mockResolvedValue("/Users/x/chosen");
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "store", type: "directory", label: "Storage folder" }])}
      />
    );
    await screen.findByLabelText("Storage folder");
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    await waitFor(() =>
      expect(pluginApi.pickPath).toHaveBeenCalledWith("acme.test", { kind: "directory" })
    );
    await waitFor(() =>
      expect(pluginApi.setSettingValue).toHaveBeenCalledWith(
        "acme.test",
        "store",
        "/Users/x/chosen",
        "user",
        null
      )
    );
  });

  it("forwards the file extensions filter to pickPath for a file field", async () => {
    pluginApi.pickPath.mockResolvedValue(null);
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "doc", type: "file", label: "Doc", extensions: ["json", "md"] }])}
      />
    );
    await screen.findByLabelText("Doc");
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    await waitFor(() =>
      expect(pluginApi.pickPath).toHaveBeenCalledWith("acme.test", {
        kind: "file",
        filters: [{ name: "Allowed files", extensions: ["json", "md"] }],
      })
    );
  });

  it("flags a mustExist path that no longer resolves on disk", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { store: "/Users/x/gone" } }));
    pluginApi.pathExists.mockResolvedValue(false);
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "store", type: "directory", label: "Storage folder", mustExist: true },
        ])}
      />
    );
    await screen.findByLabelText("Storage folder");
    await waitFor(() =>
      expect(pluginApi.pathExists).toHaveBeenCalledWith("acme.test", "/Users/x/gone")
    );
    expect(await screen.findByText(/no longer exists/)).toBeTruthy();
  });

  it("does not probe existence when mustExist is unset", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { store: "/Users/x/notes" } }));
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "store", type: "directory", label: "Storage folder" }])}
      />
    );
    const input = (await screen.findByLabelText("Storage folder")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("/Users/x/notes"));
    expect(pluginApi.pathExists).not.toHaveBeenCalled();
  });
});
