import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MinimalComponent = ComponentType<Record<string, never>>;

const panelRegistryMockState = vi.hoisted(() => ({
  missingKind: null as string | null,
}));

vi.mock("@shared/config/panelKindRegistry", async () => {
  const actual = await vi.importActual<typeof import("@shared/config/panelKindRegistry")>(
    "@shared/config/panelKindRegistry"
  );

  return {
    ...actual,
    getPanelKindConfig: (kind: string) =>
      kind === panelRegistryMockState.missingKind ? undefined : actual.getPanelKindConfig(kind),
  };
});

function mockRegistryImports(options?: { throwBrowserDefaults?: boolean }): void {
  vi.doMock("@/components/Terminal/TerminalPane", () => ({
    TerminalPane: (() => null) as MinimalComponent,
  }));
  vi.doMock("@/components/ErrorBoundary", () => ({
    ErrorBoundary: ({ children }: { children?: unknown }) => children,
  }));
  vi.doMock("@/components/Browser/BrowserPaneSkeleton", () => ({
    BrowserPaneSkeleton: (() => null) as MinimalComponent,
  }));
  vi.doMock("../terminal/serializer", () => ({ serializePtyPanel: vi.fn(() => ({ id: "term" })) }));
  vi.doMock("../terminal/defaults", () => ({ createTerminalDefaults: vi.fn(() => ({})) }));
  vi.doMock("../agent/serializer", () => ({ serializeAgent: vi.fn(() => ({ id: "agent" })) }));
  vi.doMock("../agent/defaults", () => ({ createAgentDefaults: vi.fn(() => ({})) }));
  vi.doMock("../browser/serializer", () => ({
    serializeBrowser: vi.fn(() => ({ id: "browser" })),
  }));
  vi.doMock("../browser/defaults", () => ({
    createBrowserDefaults: options?.throwBrowserDefaults
      ? vi.fn(() => {
          throw new Error("browser defaults failed");
        })
      : vi.fn(() => ({ browserUrl: "http://localhost:3000" })),
  }));
  vi.doMock("../dev-preview/serializer", () => ({
    serializeDevPreview: vi.fn(() => ({ id: "dev-preview" })),
  }));
  vi.doMock("../dev-preview/defaults", () => ({
    createDevPreviewDefaults: vi.fn(() => ({ devCommand: "npm run dev" })),
  }));
}

describe("panel registry adversarial", () => {
  beforeEach(() => {
    vi.resetModules();
    panelRegistryMockState.missingKind = null;
  });

  it("MISSING_BUILTIN_SHARED_CONFIG_FAILS_FAST", async () => {
    mockRegistryImports();
    panelRegistryMockState.missingKind = "browser";

    await expect(import("../registry")).rejects.toThrow(
      'Built-in panel kind "browser" not found in shared registry'
    );
  });

  it("INIT_AFTER_RUNTIME_OVERWRITE_REPATCHES", async () => {
    mockRegistryImports();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sharedRegistry = await import("@shared/config/panelKindRegistry");
    const registry = await import("../registry");

    registry.initBuiltInPanelKinds();
    const original = sharedRegistry.getPanelKindConfig("browser");

    sharedRegistry.registerPanelKind({
      ...sharedRegistry.getPanelKindConfig("browser")!,
      serialize: undefined,
      createDefaults: undefined,
    });
    expect(sharedRegistry.getPanelKindConfig("browser")?.serialize).toBeUndefined();

    registry.initBuiltInPanelKinds();

    const patched = sharedRegistry.getPanelKindConfig("browser");
    expect(patched?.serialize).toBe(original?.serialize);
    expect(patched?.createDefaults).toBe(original?.createDefaults);
    warnSpy.mockRestore();
  });

  it("REGISTER_UNKNOWN_KIND_NO_OP_WARNING", async () => {
    mockRegistryImports();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getPanelKindDefinition, registerPanelKindDefinition } = await import("../registry");

    registerPanelKindDefinition("missing-kind", (() => null) as MinimalComponent);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[panelKindRegistry] Cannot register definition for "missing-kind": not found in shared registry'
    );
    expect(getPanelKindDefinition("missing-kind")).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("DUPLICATE_DEFINITION_OVERWRITE_EXPLICIT", async () => {
    mockRegistryImports();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getPanelKindDefinition, registerPanelKindDefinition } = await import("../registry");
    const first = (() => null) as MinimalComponent;
    const second = (() => null) as MinimalComponent;

    registerPanelKindDefinition("browser", first);
    registerPanelKindDefinition("browser", second);

    expect(warnSpy).toHaveBeenCalledWith(
      'Panel kind definition "browser" already registered, overwriting'
    );
    expect(getPanelKindDefinition("browser")?.component).toBe(second);
    warnSpy.mockRestore();
  });

  it("DEFAULT_FACTORY_FAILURE_BUBBLES", async () => {
    mockRegistryImports({ throwBrowserDefaults: true });
    const sharedRegistry = await import("@shared/config/panelKindRegistry");
    const registry = await import("../registry");

    registry.initBuiltInPanelKinds();

    expect(() => {
      sharedRegistry.getPanelKindConfig("browser")?.createDefaults?.({ kind: "browser" });
    }).toThrow("browser defaults failed");
  });
});
