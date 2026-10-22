import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

const storeState = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
const storeMock = vi.hoisted(() => {
  const walk = (key: string, create: boolean) => {
    const parts = key.split(".");
    const last = parts.pop()!;
    let cur: Record<string, unknown> = storeState.data;
    for (const part of parts) {
      if (typeof cur[part] !== "object" || cur[part] === null) {
        if (!create) return { parent: undefined, last };
        cur[part] = {};
      }
      cur = cur[part] as Record<string, unknown>;
    }
    return { parent: cur, last };
  };
  return {
    get: vi.fn((key: string) => {
      const { parent, last } = walk(key, false);
      return parent?.[last];
    }),
    set: vi.fn((key: string, value: unknown) => {
      const { parent, last } = walk(key, true);
      parent![last] = value;
    }),
  };
});

vi.mock("electron", () => ({
  app: { getVersion: vi.fn(() => "0.0.0"), getPath: vi.fn(() => "/tmp/daintree-plugin-themes") },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  nativeTheme: { shouldUseDarkColors: true },
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
  broadcastToVisibleRenderersOrAll: vi.fn(),
  isWithheldFromView: vi.fn(() => false),
}));
vi.mock("../../store.js", () => ({ store: storeMock }));

import { PluginService } from "../PluginService.js";
import { broadcastToRenderer, broadcastToVisibleRenderersOrAll } from "../../ipc/utils.js";
import { CHANNELS } from "../../ipc/channels.js";
import { clearPluginThemeRegistry, getPluginThemeSchemes } from "../plugin/PluginThemeRegistry.js";
import { BUILT_IN_THEME_SOURCES } from "../../../shared/theme/builtInThemes/index.js";
import { toPluginThemeSnapshot } from "../../../shared/theme/pluginThemes.js";

const DAINTREE = BUILT_IN_THEME_SOURCES.find((source) => source.id === "daintree")!;
const BONDI = BUILT_IN_THEME_SOURCES.find((source) => source.id === "bondi")!;
const PLUGIN_ID = "acme.themes";
const DAWN_ID = `plugin:${PLUGIN_ID}:dawn`;

let tmpDir: string;
let service: PluginService | null;

async function writeThemePlugin(themes = ["dawn", "murky"]): Promise<void> {
  const dir = path.join(tmpDir, PLUGIN_ID);
  await fs.mkdir(path.join(dir, "themes"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name: PLUGIN_ID,
      version: "1.0.0",
      displayName: "Acme Themes",
      contributes: {
        themes: [
          { id: "dawn", name: "Dawn", type: "light", path: "./themes/dawn.json" },
          { id: "murky", name: "Murky", type: "dark", path: "./themes/murky.json" },
        ].filter((theme) => themes.includes(theme.id)),
      },
    })
  );
  // The whole built-in source: a bare palette leaves engine-derived overlay
  // tokens the gate can't verify, and the built-ins pass because they tune them.
  await fs.writeFile(
    path.join(dir, "themes", "dawn.json"),
    JSON.stringify({ palette: BONDI.palette, tokens: BONDI.tokens, extensions: BONDI.extensions })
  );
  await fs.writeFile(
    path.join(dir, "themes", "murky.json"),
    JSON.stringify({
      palette: { ...DAINTREE.palette, text: { ...DAINTREE.palette.text, primary: "#1a1a1a" } },
    })
  );
}

/** Lets the coalesced theme sync and its broadcast drain. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function themePushes(): Array<{ themes: Array<{ id: string }>; fallbackSchemeId?: string }> {
  return vi
    .mocked(broadcastToRenderer)
    .mock.calls.filter(
      ([channel, event]) =>
        channel === CHANNELS.EVENTS_PUSH &&
        (event as { name?: string }).name === "plugin:themes-changed"
    )
    .map(([, event]) => (event as { payload: never }).payload);
}

function fallbackToasts(): unknown[] {
  return vi
    .mocked(broadcastToVisibleRenderersOrAll)
    .mock.calls.filter(
      ([channel, payload]) =>
        channel === CHANNELS.NOTIFICATION_SHOW_TOAST &&
        (payload as { title?: string }).title === "Theme switched"
    );
}

/** As selecting it left the store, with a snapshot from an older version of the plugin. */
function selectDawn(): void {
  storeState.data.appTheme = {
    colorSchemeId: DAWN_ID,
    preferredLightSchemeId: "bondi",
    pluginThemeSnapshot: toPluginThemeSnapshot({
      id: DAWN_ID,
      name: "Old dawn",
      type: "light",
      pluginId: PLUGIN_ID,
      pluginName: "Acme Themes",
      palette: BONDI.palette,
    }),
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-themes-"));
  storeState.data = {};
  service = null;
  vi.mocked(broadcastToRenderer).mockClear();
  vi.mocked(broadcastToVisibleRenderersOrAll).mockClear();
});

afterEach(async () => {
  service?.dispose();
  clearPluginThemeRegistry();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PluginService plugin themes (#13832)", () => {
  it("offers the themes that clear the gate and logs the rest to the plugin's diagnostics", async () => {
    await writeThemePlugin();
    service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    await settle();

    expect(getPluginThemeSchemes().map((scheme) => scheme.id)).toEqual([DAWN_ID]);
    expect(
      themePushes()
        .at(-1)
        ?.themes.map((theme) => theme.id)
    ).toEqual([DAWN_ID]);

    const diagnostics = service
      .getDiagnosticsSnapshot()
      .plugins.find((plugin) => plugin.pluginId === PLUGIN_ID);
    expect(diagnostics?.logLines.map((line) => line.message)).toEqual([
      expect.stringMatching(/^Theme "murky" isn't offered: failed \d+ contrast check/),
    ]);
  });

  it("refreshes the snapshot of a selected theme once the catalog is complete", async () => {
    await writeThemePlugin();
    selectDawn();
    service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    await settle();

    const appTheme = storeState.data.appTheme as Record<string, unknown>;
    expect(appTheme.colorSchemeId).toBe(DAWN_ID);
    expect(appTheme.pluginThemeSnapshot).toMatchObject({
      id: DAWN_ID,
      name: "Dawn",
      tokens: BONDI.tokens,
    });
    expect(fallbackToasts()).toEqual([]);
  });

  it("falls back at startup when the selected theme's plugin is gone", async () => {
    selectDawn();
    service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    await settle();

    expect((storeState.data.appTheme as Record<string, unknown>).colorSchemeId).toBe("bondi");
    expect(fallbackToasts()).toHaveLength(1);
  });

  it("falls back when the owning plugin is disabled, and tells every view", async () => {
    await writeThemePlugin();
    selectDawn();
    service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    await settle();

    await service.setEnabled(PLUGIN_ID, false);
    await settle();

    expect((storeState.data.appTheme as Record<string, unknown>).colorSchemeId).toBe("bondi");
    expect(themePushes().at(-1)).toEqual({ themes: [], fallbackSchemeId: "bondi" });
    expect(fallbackToasts()).toHaveLength(1);
  });

  it("keeps the selection when the service is disposed at shutdown", async () => {
    await writeThemePlugin();
    selectDawn();
    service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    await settle();

    service.dispose();
    service = null;
    await settle();

    expect((storeState.data.appTheme as Record<string, unknown>).colorSchemeId).toBe(DAWN_ID);
    expect(fallbackToasts()).toEqual([]);
  });

  it("keeps the selection while a reload is between its unload and load", async () => {
    await writeThemePlugin();
    selectDawn();
    service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    await settle();

    service.unloadPlugin(PLUGIN_ID, { reload: true });
    await settle();
    expect((storeState.data.appTheme as Record<string, unknown>).colorSchemeId).toBe(DAWN_ID);
    expect(fallbackToasts()).toEqual([]);
  });

  it("keeps the selection through a reload that still offers the theme", async () => {
    await writeThemePlugin();
    selectDawn();
    service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    await settle();

    await service.loadDevPlugin(PLUGIN_ID);
    await settle();

    expect((storeState.data.appTheme as Record<string, unknown>).colorSchemeId).toBe(DAWN_ID);
    expect(getPluginThemeSchemes().map((scheme) => scheme.id)).toEqual([DAWN_ID]);
    expect(fallbackToasts()).toEqual([]);
  });

  it("falls back once a reload settles with nothing loaded, even after an incomplete scan", async () => {
    await writeThemePlugin();
    selectDawn();
    service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    await settle();
    // As if a plugin root had failed to enumerate at startup.
    Reflect.set(service, "pluginThemeCatalogReady", false);

    await fs.writeFile(path.join(tmpDir, PLUGIN_ID, "plugin.json"), "{ not json");
    await expect(service.loadDevPlugin(PLUGIN_ID)).rejects.toThrow();
    await settle();

    expect((storeState.data.appTheme as Record<string, unknown>).colorSchemeId).toBe("bondi");
    expect(fallbackToasts()).toHaveLength(1);
  });

  it("falls back once a reload settles without the selected theme", async () => {
    await writeThemePlugin();
    selectDawn();
    service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    await settle();

    await writeThemePlugin(["murky"]);
    await service.loadDevPlugin(PLUGIN_ID);
    await settle();

    expect((storeState.data.appTheme as Record<string, unknown>).colorSchemeId).toBe("bondi");
    expect(fallbackToasts()).toHaveLength(1);
  });
});
