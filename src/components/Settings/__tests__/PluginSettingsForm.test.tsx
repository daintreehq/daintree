// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { dispatchEscape, registerEscape } from "@/lib/escapeStack";
import { createContext, use } from "react";
import type { ReactNode } from "react";
import { PluginSettingsForm, lockedSecretStorageText } from "../PluginSettingsForm";
import type {
  LoadedPluginInfo,
  PluginHostedViewDescriptor,
  PluginSettingsUiValues,
  PluginSettingsViewContext,
  PluginViewHostContext,
  SettingDefinition,
} from "@shared/types/plugin";
import { _resetPluginRuntimeStatusStoreForTest } from "@/store/pluginRuntimeStatusStore";
import {
  _resetPluginHostedViewsStoreForTest,
  usePluginHostedViewsStore,
} from "@/store/pluginHostedViewsStore";
import {
  _pluginHostedViewRemovalSignalForTest,
  _resetPluginHostedViewRuntimesForTest,
} from "@/components/Plugin/PluginHostedView";

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

const madeFor = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const lastSettingsContext = vi.hoisted(() => ({
  current: undefined as PluginSettingsViewContext | undefined,
}));

// The loader is exercised by its own suites; here it only has to show what the
// settings home handed it.
vi.mock("@/components/Plugin/PluginViewContent", () => ({
  makePluginViewContent: (config: Record<string, unknown>) => {
    madeFor.push(config);
    return function FakeContent(props: {
      panelId: string;
      settingsContext?: PluginSettingsViewContext;
      hostContext?: PluginViewHostContext;
    }) {
      lastSettingsContext.current = props.settingsContext;
      return (
        <div
          data-testid="fake-settings-view"
          data-panel-id={props.panelId}
          data-scope={props.settingsContext?.scope}
          data-project={props.settingsContext?.projectId ?? ""}
          data-page={props.settingsContext?.page ?? ""}
          data-host={props.hostContext?.kind}
        >
          <input aria-label="Fake cadence" data-testid="fake-cadence" />
        </div>
      );
    };
  },
  pluginViewHostContext: (kind: string) => ({ kind }),
}));

/** Main's side of the hosted-view snapshot this project view is served. */
const hosted = vi.hoisted(() => ({
  views: [] as PluginHostedViewDescriptor[],
  listeners: new Set<(payload: { views: PluginHostedViewDescriptor[] }) => void>(),
}));

const SETTINGS_VIEW_ID = "plugin-view:acme.test/prefs";

function settingsViewDescriptor(componentPath: string): PluginHostedViewDescriptor {
  return {
    id: SETTINGS_VIEW_ID,
    pluginId: "acme.test",
    viewId: "prefs",
    location: "settings",
    name: "acme.test settings",
    componentPath,
  };
}

/** Serve this snapshot to the view, as the first pull would, before anything renders. */
function serveHostedViews(views: PluginHostedViewDescriptor[]): void {
  hosted.views = views;
  usePluginHostedViewsStore.setState({ views });
}

/** A later snapshot pushed by main: a reload, a stop, the plugin hidden here. */
function pushHostedViews(views: PluginHostedViewDescriptor[]): void {
  hosted.views = views;
  act(() => hosted.listeners.forEach((cb) => cb({ views })));
}

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
  getHostedViews: vi.fn(async () => hosted.views),
  onHostedViewsChanged: vi.fn((cb: (payload: { views: PluginHostedViewDescriptor[] }) => void) => {
    hosted.listeners.add(cb);
    return () => hosted.listeners.delete(cb);
  }),
  getSettingValues: vi.fn(),
  setSettingValue: vi.fn().mockResolvedValue(undefined),
  deleteSettingValue: vi.fn().mockResolvedValue(undefined),
  revealSecretSetting: vi.fn(),
  pickPath: vi.fn(),
  pathExists: vi.fn(),
  getSetupStatus: vi.fn(),
  setSetupStepSkipped: vi.fn(),
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
  madeFor.length = 0;
  vi.clearAllMocks();
  hosted.views = [];
  _resetPluginHostedViewRuntimesForTest();
  _resetPluginHostedViewsStoreForTest();
  _resetPluginRuntimeStatusStoreForTest();
  Element.prototype.scrollIntoView = vi.fn();
  pluginApi.setSettingValue.mockResolvedValue(undefined);
  pluginApi.deleteSettingValue.mockResolvedValue(undefined);
  pluginApi.getSettingValues.mockResolvedValue(uiValues());
  pluginApi.pickPath.mockResolvedValue(null);
  pluginApi.pathExists.mockResolvedValue(true);
  pluginApi.getSetupStatus.mockResolvedValue({ steps: [] });
  pluginApi.setSetupStepSkipped.mockResolvedValue(undefined);
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
        plugin={makePlugin([
          {
            id: "mode",
            type: "enum",
            label: "Mode",
            options: ["Only the essentials", "Everything"],
          },
        ])}
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
        plugin={makePlugin([
          {
            id: "mode",
            type: "enum",
            label: "Mode",
            options: ["Only the essentials", "Everything"],
          },
        ])}
      />
    );
    const select = (await screen.findByRole("combobox", { name: "Mode" })) as HTMLButtonElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.click(select);
    await waitFor(() => expect(select.getAttribute("aria-expanded")).toBe("true"));
    // Picking an option starts a save, which disables the field.
    fireEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", { name: "Everything" })
    );
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

  it("keeps a typed replacement secret through Reveal and Hide", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ secretsSet: ["token"] }));
    pluginApi.revealSecretSetting.mockResolvedValue("old-secret");
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "token", type: "secret", label: "Token" }])} />
    );
    const input = (await screen.findByLabelText("Token")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "new-secret" } });

    // The toggle only changes masking of what was typed; it never swaps in the stored value.
    const toggle = screen.getByRole("button", { name: "Show Token" });
    fireEvent.click(toggle);
    expect(input.type).toBe("text");
    expect(input.value).toBe("new-secret");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(input.type).toBe("password");
    expect(input.value).toBe("new-secret");
    expect(pluginApi.revealSecretSetting).not.toHaveBeenCalled();
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

    fireEvent.click(await screen.findByRole("button", { name: "Show Token" }));
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
    // With no keychain at all, another try is refused the same way.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  // Electron asks for the keychain once per run: after a dismissed unlock prompt
  // every save this session is refused, and only a restart asks again.
  it("says the keychain is locked for the session instead of offering a Retry that can't work", async () => {
    pluginApi.getSettingValues
      .mockResolvedValueOnce(uiValues({ secretTier: "keychain" }))
      .mockResolvedValue(uiValues({ secretTier: "locked" }));
    pluginApi.setSettingValue.mockRejectedValue(
      new Error(
        `The keyring wasn't available this session, so the secret "token" wasn't saved — restart Daintree to try again`
      )
    );
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "token", type: "secret", label: "Token" },
          { id: "other", type: "secret", label: "Other" },
        ])}
      />
    );

    const input = (await screen.findByLabelText("Token")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(screen.getAllByText("New secrets are stored in the OS keychain")).toHaveLength(2);
    fireEvent.change(input, { target: { value: "sk-typed" } });
    fireEvent.blur(input);

    expect(await screen.findByText(/wasn't saved — restart Daintree/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // Every secret row now says so, not just the one that tried.
    await waitFor(() =>
      expect(
        screen.getAllByText(/not available this session — restart Daintree to try again$/)
      ).toHaveLength(2)
    );
    expect(screen.queryByText("New secrets are stored in the OS keychain")).toBeNull();
    expect(input.value).toBe("sk-typed");
  });

  it("still offers Retry when the keychain is there and only this save failed", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ secretTier: "keychain" }));
    pluginApi.setSettingValue.mockRejectedValueOnce(
      new Error("Secure storage didn't answer within 60 s. It may be waiting on a password prompt.")
    );
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "token", type: "secret", label: "Token" }])} />
    );

    const input = (await screen.findByLabelText("Token")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "sk-typed" } });
    fireEvent.blur(input);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(pluginApi.setSettingValue).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Stored in OS keychain")).toBeTruthy();
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

  it("shows an installed plugin's fields in their one home each, with a scope badge", async () => {
    currentProjectId = "proj-1";
    const plugin = makePlugin([
      { id: "u", type: "string", label: "U" },
      { id: "p", type: "string", label: "P", scope: "project" },
      { id: "l", type: "string", label: "L", scope: "local" },
    ]);

    // The plugin manager holds what applies to every project, and points on.
    const manager = render(<PluginSettingsForm plugin={plugin} viewScope="user" />);
    expect(await screen.findByText("All projects")).toBeTruthy();
    expect(screen.queryByLabelText("P")).toBeNull();
    expect(screen.queryByLabelText("L")).toBeNull();
    expect(screen.getByRole("button", { name: "Open project settings" })).toBeTruthy();
    manager.unmount();

    // Project settings hold what differs per project, and point back.
    render(<PluginSettingsForm plugin={plugin} viewScope="project" />);
    // Named for what a change reaches: one project, or every project.
    expect(await screen.findByText("This project")).toBeTruthy();
    expect(screen.getByText("This project, this machine")).toBeTruthy();
    expect(screen.queryByText("All projects")).toBeNull();
    expect(screen.queryByLabelText("U")).toBeNull();
    expect(screen.getByRole("button", { name: "Open plugin manager" })).toBeTruthy();
  });

  it("shows every field of a project plugin in its project home, and none in the manager", async () => {
    currentProjectId = "proj-1";
    const plugin = {
      ...makePlugin([
        { id: "u", type: "string", label: "U" },
        { id: "p", type: "string", label: "P", scope: "project" },
      ]),
      origin: "project" as const,
    };
    render(<PluginSettingsForm plugin={plugin} viewScope="project" />);
    expect(await screen.findByLabelText("U")).toBeTruthy();
    expect(screen.getByLabelText("P")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open (plugin manager|project settings)/ })).toBe(
      null
    );
  });

  it("shows an unstored required field as unset, with its default as the way to set it", async () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "region", type: "string", label: "Region", required: true, default: "us" },
          { id: "port", type: "number", label: "Port", default: 80 },
        ])}
      />
    );
    const input = (await screen.findByLabelText("Region")) as HTMLInputElement;
    // A default never satisfies a required setting, so the field doesn't wear it
    // as a value: it is empty, and the row says so and names the default.
    const row0 = input.closest<HTMLElement>("[data-settings-row]")!;
    await waitFor(() => expect(row0.textContent).toContain("Not set yet"));
    expect(input.value).toBe("");
    const row = input.closest<HTMLElement>("[data-settings-row]")!;
    expect(row.textContent).toContain("Not set yet");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(input);
    expect(pluginApi.setSettingValue).not.toHaveBeenCalled();

    // An optional field with a default needs no acceptance: its default applies.
    const port = (await screen.findByLabelText("Port")) as HTMLInputElement;
    await waitFor(() => expect(port.value).toBe("80"));
    expect(screen.getAllByRole("button", { name: /^Use / })).toHaveLength(1);

    fireEvent.click(within(row).getByRole("button", { name: "Use \u201cus\u201d" }));
    await waitFor(() =>
      expect(pluginApi.setSettingValue).toHaveBeenCalledWith(
        "acme.test",
        "region",
        "us",
        "user",
        null
      )
    );
    await waitFor(() => expect(input.value).toBe("us"));
    expect(row.textContent).not.toContain("Not set yet");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
  });

  it("offers no default acceptance once a required value is stored", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { region: "eu" } }));
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "region", type: "string", label: "Region", required: true, default: "us" },
        ])}
      />
    );
    const input = (await screen.findByLabelText("Region")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("eu"));
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
    expect(screen.queryByText(/Not set yet/)).toBeNull();
  });

  it("drops a validation error once the field is back to its saved value", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { port: 8080 } }));
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "port", type: "number", label: "Port" }])} />
    );
    const input = (await screen.findByLabelText("Port")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("8080"));

    fireEvent.change(input, { target: { value: "eighty" } });
    fireEvent.blur(input);
    const row = input.closest<HTMLElement>("[data-settings-row]")!;
    await waitFor(() => expect(row.textContent).toContain("Enter a valid number"));
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(input, { target: { value: "8080" } });
    fireEvent.blur(input);
    await waitFor(() => expect(row.textContent).not.toContain("Enter a valid number"));
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(pluginApi.setSettingValue).not.toHaveBeenCalled();
  });

  it("offers a failed write again from its row, and a rejected draft only its correction", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { port: 8080 } }));
    pluginApi.setSettingValue.mockRejectedValueOnce(new Error("EACCES"));
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "port", type: "number", label: "Port" }])} />
    );
    const input = (await screen.findByLabelText("Port")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("8080"));
    const row = input.closest<HTMLElement>("[data-settings-row]")!;

    fireEvent.change(input, { target: { value: "9090" } });
    fireEvent.blur(input);
    await waitFor(() => expect(row.textContent).toContain("EACCES"));
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(pluginApi.setSettingValue).toHaveBeenCalledTimes(2));
    expect(pluginApi.setSettingValue.mock.calls[1]).toEqual(
      pluginApi.setSettingValue.mock.calls[0]
    );
    await waitFor(() => expect(row.textContent).not.toContain("EACCES"));

    // Not a number: nothing was written, so there is nothing to retry — only to fix.
    fireEvent.change(input, { target: { value: "ninety" } });
    fireEvent.blur(input);
    await waitFor(() => expect(row.textContent).toContain("Enter a valid number"));
    expect(within(row).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says a path couldn't be checked, rather than that it's fine, and checks again", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { out: "/srv/data" } }));
    pluginApi.pathExists.mockRejectedValueOnce(new Error("EIO")).mockResolvedValue(false);
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "out", type: "directory", label: "Data folder", mustExist: true },
        ])}
      />
    );
    const input = (await screen.findByLabelText("Data folder")) as HTMLInputElement;
    const row = input.closest<HTMLElement>("[data-settings-row]")!;
    await waitFor(() =>
      expect(row.textContent).toContain("Couldn't check that this folder still exists")
    );
    // Not known to be wrong, so the field isn't marked invalid.
    expect(input.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(row.textContent).toContain("This folder no longer exists"));
  });

  it("puts a picked path back when saving it fails", async () => {
    pluginApi.getSettingValues.mockResolvedValue(uiValues({ values: { out: "/srv/old" } }));
    pluginApi.pickPath.mockResolvedValue("/srv/new");
    pluginApi.setSettingValue.mockRejectedValueOnce(new Error("EACCES"));
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "out", type: "directory", label: "Output folder" }])}
      />
    );
    const input = (await screen.findByLabelText("Output folder")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("/srv/old"));

    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    const row = input.closest<HTMLElement>("[data-settings-row]")!;
    await waitFor(() => expect(row.textContent).toContain("EACCES"));
    // The field shows what is saved, not the pick that wasn't.
    expect(input.value).toBe("/srv/old");
  });

  it("disables project-scoped fields when no project is active", async () => {
    currentProjectId = null;
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "p", type: "string", label: "P", scope: "project" }])}
        viewScope="project"
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
    // Its smaller mono face must not shrink it below the group's other inputs.
    expect(input.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xs", "leading-5"]));
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

// The no-key result can't say why, so neither do the words.
describe("a keychain that gave no key this session", () => {
  // A dismissed unlock prompt and a keyring service that isn't running end alike.
  it("claims no more than an unavailable keyring on Linux", () => {
    expect(lockedSecretStorageText(null, "linux")).toBe(
      "Keyring not available this session — restart Daintree to try again"
    );
  });

  // Chromium reports a refusal and any other Keychain error alike.
  it("claims no more than an unavailable Keychain on macOS", () => {
    expect(lockedSecretStorageText(null, "darwin")).toBe(
      "Keychain not available this session — restart Daintree to try again"
    );
  });

  it("names the host and restarts Daintree there for a remote window", () => {
    expect(lockedSecretStorageText({ name: "studio-01" }, "linux")).toBe(
      "Keyring on studio-01 not available this session — restart Daintree there to try again"
    );
    expect(lockedSecretStorageText({ name: "studio-01" }, "darwin")).toBe(
      "Keychain on studio-01 not available this session — restart Daintree there to try again"
    );
  });
});

/**
 * A plugin that declares a settings view. Given a module URL, main serves that
 * view to this project too — the running case every home normally sees.
 */
function makeViewPlugin(
  settings: SettingDefinition[],
  settingsViewPath?: string,
  overrides: { declaresView?: boolean; disabled?: boolean } = {}
): LoadedPluginInfo {
  const declaresView = overrides.declaresView ?? settingsViewPath !== undefined;
  if (settingsViewPath !== undefined) serveHostedViews([settingsViewDescriptor(settingsViewPath)]);
  return {
    manifest: {
      name: "acme.test",
      version: "1.0.0",
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        commands: [],
        views: declaresView
          ? [{ id: "prefs", componentPath: "dist/prefs.js", location: "settings" }]
          : [],
        mcpServers: [],
        skills: [],
        keybindings: [],
        contextMenus: [],
        forgeProviders: [],
        fileDecorationProviders: [],
        fileEditors: [],
        agents: [],
        processTools: [],
        recipes: [],
        settings,
      },
    },
    instanceId: "acme.test",
    origin: "global",
    projectId: null,
    dir: "/plugins/acme.test",
    loadedAt: 1,
    isBuiltin: false,
    source: "sideload",
    installedAt: 1,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    disabled: overrides.disabled ?? false,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: false,
  };
}

describe("PluginSettingsForm custom settings section", () => {
  it("mounts the plugin's settings view below its fields in the plugin manager home", () => {
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([{ id: "apiKey", type: "secret" }], "plugin://a/settings.js")}
        viewScope="user"
      />
    );

    const view = screen.getByTestId("fake-settings-view");
    expect(view.getAttribute("data-scope")).toBe("user");
    expect(view.getAttribute("data-project")).toBe("");
    expect(view.getAttribute("data-host")).toBe("settings");
    // Below the declared fields, in its own host-owned group.
    const field = document.getElementById("plugin-setting-acme.test-apiKey")!;
    expect(field.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("plugin-settings-view").closest(".settings-card")).not.toBeNull();
    expect(madeFor[0]).toMatchObject({
      id: SETTINGS_VIEW_ID,
      componentPath: "plugin://a/settings.js",
      extensionId: "acme.test",
      standalone: true,
    });
  });

  it("mounts it with the project context in Project settings", () => {
    currentProjectId = "proj-1";
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([], "plugin://a/settings.js")}
        viewScope="project"
      />
    );

    const view = screen.getByTestId("fake-settings-view");
    expect(view.getAttribute("data-scope")).toBe("project");
    expect(view.getAttribute("data-project")).toBe("proj-1");
    // A view-only plugin draws no empty group for fields it doesn't have.
    expect(document.querySelectorAll(".settings-card")).toHaveLength(1);
  });

  it("says a stopped plugin's section needs it enabled, instead of dropping it", () => {
    serveHostedViews([]);
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([], undefined, { declaresView: true, disabled: true })}
        viewScope="user"
      />
    );
    expect(screen.queryByTestId("fake-settings-view")).toBeNull();
    expect(screen.getByText("Available when the plugin is enabled")).toBeTruthy();
  });

  it("unmounts a running section the home knows has stopped, before its snapshot catches up", () => {
    currentProjectId = "proj-1";
    const plugin = makeViewPlugin([], "plugin://a/settings.js");
    const { rerender } = render(<PluginSettingsForm plugin={plugin} viewScope="project" />);
    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();

    rerender(<PluginSettingsForm plugin={plugin} viewScope="project" viewRunning={false} />);
    expect(screen.queryByTestId("fake-settings-view")).toBeNull();
    expect(screen.getByText("Available while the plugin is running")).toBeTruthy();
  });

  it("says the section isn't available here when this project isn't served it", () => {
    // Running, but main serves this project no section for it.
    serveHostedViews([]);
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([{ id: "region", type: "string", label: "Region" }], undefined, {
          declaresView: true,
        })}
        viewScope="user"
      />
    );

    expect(screen.queryByTestId("fake-settings-view")).toBeNull();
    expect(screen.getByText("Not available in this project")).toBeTruthy();
    // The generated fields are the host's own and keep working.
    expect(screen.getByText("Region")).toBeTruthy();
  });

  it("waits for the first snapshot rather than calling a served section unavailable", async () => {
    let resolvePull: (views: PluginHostedViewDescriptor[]) => void = () => {};
    pluginApi.getHostedViews.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePull = resolve))
    );
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([], undefined, { declaresView: true })}
        viewScope="user"
      />
    );
    expect(screen.queryByText(/^Available/)).toBeNull();
    expect(screen.queryByTestId("fake-settings-view")).toBeNull();

    await act(async () => resolvePull([settingsViewDescriptor("plugin://a/settings.js")]));

    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();
  });

  it("retires a cached runtime when its plugin reloads or stops, with no settings page open", () => {
    // Mounted once, then the page closes: the runtime stays cached.
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([], "plugin://a/__dtv-3/settings.js")}
        viewScope="user"
      />
    );
    cleanup();
    const signal = _pluginHostedViewRemovalSignalForTest(SETTINGS_VIEW_ID)!;
    expect(signal.aborted).toBe(false);

    // The same module still served: nothing to retire.
    pushHostedViews([settingsViewDescriptor("plugin://a/__dtv-3/settings.js")]);
    expect(signal.aborted).toBe(false);

    // Reloaded onto a new module: retired at once, not on the next visit.
    pushHostedViews([settingsViewDescriptor("plugin://b/__dtv-4/settings.js")]);
    expect(signal.aborted).toBe(true);
    expect(_pluginHostedViewRemovalSignalForTest(SETTINGS_VIEW_ID)).toBeUndefined();

    // Stopped (or hidden here): the same, for the runtime minted after the reload.
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([], "plugin://b/__dtv-4/settings.js")}
        viewScope="user"
      />
    );
    cleanup();
    const next = _pluginHostedViewRemovalSignalForTest(SETTINGS_VIEW_ID)!;
    pushHostedViews([]);
    expect(next.aborted).toBe(true);
  });

  it("offers a retry when the first snapshot couldn't be read, and mounts once it is", async () => {
    pluginApi.getHostedViews.mockRejectedValueOnce(new Error("ipc down"));
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([], undefined, { declaresView: true })}
        viewScope="user"
      />
    );

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Couldn't load this section")).toBeTruthy();

    hosted.views = [settingsViewDescriptor("plugin://a/settings.js")];
    fireEvent.click(retry);

    expect(await screen.findByTestId("fake-settings-view")).toBeTruthy();
    expect(screen.queryByText("Couldn't load this section")).toBeNull();
  });

  it("rides a reload through its empty snapshot onto the new module", () => {
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([], "plugin://a/__dtv-3/settings.js")}
        viewScope="user"
      />
    );
    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();

    // Main unloads before the replacement registers: for a moment nothing is
    // served, and the section says only what it sees.
    pushHostedViews([]);
    expect(screen.queryByTestId("fake-settings-view")).toBeNull();
    expect(screen.getByText("Not available in this project")).toBeTruthy();

    pushHostedViews([settingsViewDescriptor("plugin://b/__dtv-4/settings.js")]);
    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();
    expect(madeFor.at(-1)?.componentPath).toBe("plugin://b/__dtv-4/settings.js");
  });

  it("swaps a mounted view for the reloaded module while the page stays open", () => {
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([], "plugin://a/__dtv-3/settings.js")}
        viewScope="user"
      />
    );
    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();

    // A dev rebuild: main serves the new module; the props never change.
    pushHostedViews([settingsViewDescriptor("plugin://b/__dtv-4/settings.js")]);

    expect(madeFor.at(-1)?.componentPath).toBe("plugin://b/__dtv-4/settings.js");
    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();
  });

  it("renders nothing for a plugin with neither fields nor a view", () => {
    const { container } = render(
      <PluginSettingsForm plugin={makeViewPlugin([])} viewScope="user" />
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("PluginSettingsForm deep-link landing", () => {
  it("lands on the requested setting once its value has loaded, and reports it handled", async () => {
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([
          { id: "region", type: "string" },
          { id: "apiKey", type: "secret", required: true },
        ])}
        viewScope="user"
        focusRequest={{ key: "apiKey", nonce: 7 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(7));
    const row = document.getElementById("plugin-setting-acme.test-apiKey")!;
    expect(row.classList.contains("settings-highlight")).toBe(true);
    expect(row.scrollIntoView).toHaveBeenCalled();
    expect(row.contains(document.activeElement)).toBe(true);
    expect(row.textContent).toContain("Required");
  });

  it("waits for a hidden settings tab to show before landing", async () => {
    const onFocusHandled = vi.fn();
    const { container } = render(
      <div className="hidden" data-testid="tab">
        <PluginSettingsForm
          plugin={makeViewPlugin([{ id: "apiKey", type: "string" }])}
          viewScope="user"
          focusRequest={{ key: "apiKey", nonce: 9 }}
          onFocusHandled={onFocusHandled}
        />
      </div>
    );
    const row = await waitFor(() => document.getElementById("plugin-setting-acme.test-apiKey")!);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(onFocusHandled).not.toHaveBeenCalled();
    expect(row.classList.contains("settings-highlight")).toBe(false);

    // The dialog switches to the tab: the next retry lands.
    container.querySelector('[data-testid="tab"]')!.classList.remove("hidden");
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(9));
    expect(row.classList.contains("settings-highlight")).toBe(true);
  });

  it("still reports a request for a key it doesn't declare, so it isn't left pending", async () => {
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([{ id: "region", type: "string" }])}
        viewScope="user"
        focusRequest={{ key: "gone", nonce: 3 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(3));
    expect(document.querySelector(".settings-highlight")).toBeNull();
  });
});

describe("PluginSettingsForm settings edited by the plugin's own section", () => {
  const cadence: SettingDefinition = {
    id: "cadence",
    type: "json",
    label: "Posting cadence",
    editor: "view",
  };
  const channel: SettingDefinition = { id: "channel", type: "string", label: "Default channel" };

  it("leaves a view-edited value to the plugin's section instead of showing it twice", () => {
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([cadence, channel], "plugin://a/settings.js")}
        viewScope="user"
      />
    );

    expect(screen.queryByText("Posting cadence")).toBeNull();
    expect(screen.getByText("Default channel")).toBeTruthy();
    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();
  });

  it("lands a link to a view-edited key on the plugin's own section", async () => {
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([cadence, channel], "plugin://a/settings.js")}
        viewScope="user"
        focusRequest={{ key: "cadence", nonce: 3 }}
        onFocusHandled={onFocusHandled}
      />
    );

    // The fake view never answers, as a view built before it could: the host
    // stops waiting and lands on the whole section.
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(3), { timeout: 3000 });
    const section = screen.getByTestId("fake-settings-view").closest(".settings-highlight");
    expect(section).not.toBeNull();
  });

  it("hands the key to the section, which lands on its own control and answers", async () => {
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([cadence, channel], "plugin://a/settings.js")}
        viewScope="user"
        focusRequest={{ key: "cadence", nonce: 4 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(lastSettingsContext.current?.focus?.key).toBe("cadence"));
    expect(onFocusHandled).not.toHaveBeenCalled();
    const control = screen.getByTestId("fake-cadence");
    const acknowledge = lastSettingsContext.current!.focus!.acknowledge;
    act(() => {
      control.focus();
      acknowledge(true);
    });

    expect(onFocusHandled).toHaveBeenCalledWith(4);
    expect(document.activeElement).toBe(control);
    // Answered: the host doesn't also land on the whole section.
    expect(document.querySelector(".settings-highlight")).toBeNull();
    await waitFor(() => expect(lastSettingsContext.current?.focus).toBeUndefined());
    // A second answer for the same request does nothing.
    act(() => acknowledge(false));
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".settings-highlight")).toBeNull();
  });

  it("falls back to landing on the section when the view can't show the key", async () => {
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={makeViewPlugin([cadence, channel], "plugin://a/settings.js")}
        viewScope="user"
        focusRequest={{ key: "cadence", nonce: 5 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(lastSettingsContext.current?.focus?.nonce).toBe(5));
    act(() => lastSettingsContext.current!.focus!.acknowledge(false));

    expect(onFocusHandled).toHaveBeenCalledWith(5);
    expect(
      screen.getByTestId("fake-settings-view").closest(".settings-highlight")
    ).not.toBeNull();
  });

  it("still shows the field when the plugin declares no section to edit it", () => {
    render(<PluginSettingsForm plugin={makeViewPlugin([cadence, channel])} viewScope="user" />);

    expect(screen.getByText("Posting cadence")).toBeTruthy();
  });
});

describe("PluginSettingsForm custom section pages (#14101)", () => {
  function withPages(plugin: LoadedPluginInfo): LoadedPluginInfo {
    return {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        contributes: {
          ...plugin.manifest.contributes,
          views: [
            {
              id: "prefs",
              componentPath: "dist/prefs.js",
              location: "settings",
              pages: [
                { id: "columns", title: "Column mapping", description: "Statuses to columns" },
              ],
            },
          ],
        },
      },
    } as LoadedPluginInfo;
  }

  it("lists the pages, opens one in the same mount, and goes back to its Open button", async () => {
    render(
      <PluginSettingsForm
        plugin={withPages(makeViewPlugin([], "plugin://a/settings.js"))}
        viewScope="user"
      />
    );
    const view = screen.getByTestId("fake-settings-view");
    expect(view.getAttribute("data-page")).toBe("");

    const open = screen.getByRole("button", { name: "Open Column mapping" });
    fireEvent.click(open);

    const heading = await screen.findByRole("heading", { name: "Column mapping" });
    expect(document.activeElement).toBe(heading);
    // The same view instance, now told which page is open.
    expect(screen.getByTestId("fake-settings-view")).toBe(view);
    expect(view.getAttribute("data-page")).toBe("columns");
    expect(screen.queryByRole("button", { name: "Open Column mapping" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to all settings" }));
    const reopened = await screen.findByRole("button", { name: "Open Column mapping" });
    await waitFor(() => expect(document.activeElement).toBe(reopened));
    expect(view.getAttribute("data-page")).toBe("");
  });

  it("opens a page from a deep link and lands on its heading", async () => {
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={withPages(makeViewPlugin([], "plugin://a/settings.js"))}
        viewScope="user"
        focusRequest={{ section: "custom", page: "columns", nonce: 12 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(12));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Column mapping" }));
    expect(screen.getByTestId("fake-settings-view").getAttribute("data-page")).toBe("columns");
  });
});

describe("PluginSettingsForm custom section links (#14101 review)", () => {
  function withPages(plugin: LoadedPluginInfo): LoadedPluginInfo {
    return {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        contributes: {
          ...plugin.manifest.contributes,
          views: [
            {
              id: "prefs",
              componentPath: "dist/prefs.js",
              location: "settings",
              pages: [{ id: "columns", title: "Column mapping" }],
            },
          ],
        },
      },
    } as LoadedPluginInfo;
  }

  it("goes back to the section's root for a link that names no page", async () => {
    const plugin = withPages(makeViewPlugin([], "plugin://a/settings.js"));
    const onFocusHandled = vi.fn();
    const { rerender } = render(<PluginSettingsForm plugin={plugin} viewScope="user" />);
    fireEvent.click(screen.getByRole("button", { name: "Open Column mapping" }));
    await screen.findByRole("heading", { name: "Column mapping" });

    rerender(
      <PluginSettingsForm
        plugin={plugin}
        viewScope="user"
        focusRequest={{ section: "custom", nonce: 21 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(21));
    expect(screen.queryByRole("heading", { name: "Column mapping" })).toBeNull();
    expect(screen.getByTestId("fake-settings-view").getAttribute("data-page")).toBe("");
  });

  it("lands a page link on the section, with focus, when the plugin can't show it", async () => {
    serveHostedViews([]);
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={withPages(makeViewPlugin([], undefined, { declaresView: true, disabled: true }))}
        viewScope="user"
        focusRequest={{ section: "custom", page: "columns", nonce: 22 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(22), { timeout: 3000 });
    const section = document.getElementById("plugin-settings-view-acme.test")!;
    expect(section.classList.contains("settings-highlight")).toBe(true);
    expect(document.activeElement).toBe(section);
  });
});

describe("PluginSettingsForm after the plugin reloads with new declarations", () => {
  it("re-reads stored values instead of showing a newly declared field as unset", async () => {
    const channel: SettingDefinition = { id: "channel", type: "string", label: "Channel" };
    const extra: SettingDefinition = { id: "extra", type: "string", label: "Extra" };
    const first = makeViewPlugin([channel]);
    const { rerender } = render(<PluginSettingsForm plugin={first} viewScope="user" />);
    await waitFor(() => expect(pluginApi.getSettingValues).toHaveBeenCalledTimes(1));

    rerender(
      <PluginSettingsForm
        plugin={{ ...makeViewPlugin([channel, extra]), loadedAt: 2 }}
        viewScope="user"
      />
    );

    await waitFor(() => expect(pluginApi.getSettingValues).toHaveBeenCalledTimes(2));
  });
});

describe("PluginSettingsForm setup checklist (#13824)", () => {
  function withSetup(plugin: LoadedPluginInfo): LoadedPluginInfo {
    return {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        contributes: {
          ...plugin.manifest.contributes,
          setup: [
            { id: "sync", title: "Run the first sync", done: { kind: "context", when: "x" } },
          ],
        },
      },
    } as LoadedPluginInfo;
  }

  const STATUS = {
    steps: [
      {
        id: "sync",
        title: "Run the first sync",
        description: null,
        check: { kind: "observed", done: false },
        action: null,
        skipped: false,
      },
    ],
  };

  it("puts the checklist above the plugin's own fields", async () => {
    currentProjectId = "proj-1";
    pluginApi.getSetupStatus.mockResolvedValue(STATUS);
    render(
      <PluginSettingsForm
        plugin={withSetup(makePlugin([{ id: "apiKey", type: "string", label: "API key" }]))}
      />
    );

    const group = await screen.findByRole("group", { name: "Setup · 0 of 1" });
    const field = screen.getByLabelText("API key");
    expect(group.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pluginApi.getSetupStatus).toHaveBeenCalledWith("acme.test", "proj-1");

    fireEvent.click(screen.getByRole("button", { name: "Skip: Run the first sync" }));
    expect(pluginApi.setSetupStepSkipped).toHaveBeenCalledWith("acme.test", "sync", true);
  });

  it("lands a setup deep link on the checklist once it has loaded", async () => {
    pluginApi.getSetupStatus.mockResolvedValue(STATUS);
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={withSetup(makePlugin([{ id: "apiKey", type: "string", label: "API key" }]))}
        focusRequest={{ section: "setup", nonce: 11 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(11));
    const group = screen.getByRole("group", { name: "Setup · 0 of 1" });
    expect(group.closest(".settings-highlight")).not.toBeNull();
    // Landing focuses the checklist; it never runs a step.
    expect(pluginApi.setSetupStepSkipped).not.toHaveBeenCalled();
  });

  it("shows a checklist for a plugin with nothing else to configure", async () => {
    pluginApi.getSetupStatus.mockResolvedValue(STATUS);
    render(<PluginSettingsForm plugin={withSetup(makePlugin([]))} />);
    expect(await screen.findByRole("group", { name: "Setup · 0 of 1" })).toBeTruthy();
  });

  it("shows what it can see with no project open, and offers no skip", async () => {
    pluginApi.getSetupStatus.mockResolvedValue(STATUS);
    render(<PluginSettingsForm plugin={withSetup(makePlugin([]))} />);
    await screen.findByRole("group", { name: "Setup · 0 of 1" });
    expect(screen.queryByRole("button", { name: /^Skip/ })).toBeNull();
  });

  it("keeps an installed plugin's checklist out of Project settings", async () => {
    currentProjectId = "proj-1";
    pluginApi.getSetupStatus.mockResolvedValue(STATUS);
    const { container } = render(
      <PluginSettingsForm plugin={withSetup(makePlugin([]))} viewScope="project" />
    );
    expect(container.textContent).toBe("");
    expect(pluginApi.getSetupStatus).not.toHaveBeenCalled();
  });
});
