import { describe, it, expectTypeOf } from "vitest";
import type {
  PluginManifest,
  PluginHostApi,
  PluginActivate,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  MenuItemLocation,
  ViewContribution,
  ViewLocation,
  McpServerContribution,
  PluginPermission,
  BuiltInPluginPermission,
  PluginActionContribution,
  PluginWorktreeSnapshot,
  PluginWorktreeLinked,
  PluginWorktreeLinkedIssue,
  PluginWorktreeLinkedPR,
  PluginIpcContext,
  PluginIpcHandler,
  ForgeProviderImpl,
  ForgeProviderDescriptor,
  ForgeProviderContribution,
  FileDecorationProviderImpl,
  FileDecorationProviderDescriptor,
  FileDecorationContribution,
  NormalizedPRState,
  ResourceRef,
  CIStatus,
} from "../plugin-sdk.js";

/**
 * Boundary test for @daintreehq/plugin-sdk.
 *
 * Verifies that the SDK barrel exports every symbol classified as SDK-public
 * and that the types resolve to the expected source module (plugin.ts for
 * manifest/host types, forge.ts for forge projection types).
 */
describe("plugin-sdk boundary", () => {
  describe("all SDK-public exports resolve", () => {
    it("exports manifest authoring types", () => {
      expectTypeOf<PanelContribution>().toMatchTypeOf<object>();
      expectTypeOf<ToolbarButtonContribution>().toMatchTypeOf<object>();
      expectTypeOf<MenuItemContribution>().toMatchTypeOf<object>();
      expectTypeOf<MenuItemLocation>().toMatchTypeOf<string>();
      expectTypeOf<ViewContribution>().toMatchTypeOf<object>();
      expectTypeOf<ViewLocation>().toMatchTypeOf<string>();
      expectTypeOf<McpServerContribution>().toMatchTypeOf<object>();
      expectTypeOf<PluginPermission>().toMatchTypeOf<string>();
      expectTypeOf<BuiltInPluginPermission>().toMatchTypeOf<string>();
      expectTypeOf<PluginActionContribution>().toMatchTypeOf<object>();
    });

    it("exports manifest root", () => {
      expectTypeOf<PluginManifest>().toMatchTypeOf<object>();
    });

    it("exports activation contract", () => {
      expectTypeOf<PluginActivate>().toMatchTypeOf<(...args: never[]) => unknown>();
      expectTypeOf<PluginHostApi>().toMatchTypeOf<object>();
    });

    it("exports IPC types", () => {
      expectTypeOf<PluginIpcContext>().toMatchTypeOf<object>();
      expectTypeOf<PluginIpcHandler>().toMatchTypeOf<(...args: never[]) => unknown>();
    });

    it("exports worktree projections", () => {
      expectTypeOf<PluginWorktreeSnapshot>().toMatchTypeOf<object>();
      expectTypeOf<PluginWorktreeLinked>().toMatchTypeOf<object>();
      expectTypeOf<PluginWorktreeLinkedIssue>().toMatchTypeOf<object>();
      expectTypeOf<PluginWorktreeLinkedPR>().toMatchTypeOf<object>();
    });

    it("exports forge provider contract", () => {
      expectTypeOf<ForgeProviderImpl>().toMatchTypeOf<object>();
      expectTypeOf<ForgeProviderDescriptor>().toMatchTypeOf<object>();
      expectTypeOf<ForgeProviderContribution>().toMatchTypeOf<object>();
    });

    it("exports file decoration contract", () => {
      expectTypeOf<FileDecorationProviderImpl>().toMatchTypeOf<object>();
      expectTypeOf<FileDecorationProviderDescriptor>().toMatchTypeOf<object>();
      expectTypeOf<FileDecorationContribution>().toMatchTypeOf<object>();
    });

    it("exports forge projection types", () => {
      expectTypeOf<NormalizedPRState>().toMatchTypeOf<string>();
      expectTypeOf<ResourceRef>().toMatchTypeOf<object>();
      expectTypeOf<CIStatus>().toMatchTypeOf<object>();
    });
  });

  describe("structural contracts", () => {
    it("NormalizedPRState accepts all four literals", () => {
      expectTypeOf("open" as const).toMatchTypeOf<NormalizedPRState>();
      expectTypeOf("merged" as const).toMatchTypeOf<NormalizedPRState>();
      expectTypeOf("closed" as const).toMatchTypeOf<NormalizedPRState>();
      expectTypeOf("declined" as const).toMatchTypeOf<NormalizedPRState>();
    });

    it("PluginHostApi.getActiveWorktree returns snapshot or null", () => {
      const host = {} as PluginHostApi;
      expectTypeOf(host.getActiveWorktree).toEqualTypeOf<
        () => Promise<PluginWorktreeSnapshot | null>
      >();
    });

    it("PluginIpcContext has required fields", () => {
      const ctx: PluginIpcContext = {
        projectId: null,
        worktreeId: null,
        webContentsId: 1,
        pluginId: "test.plugin",
      };
      expectTypeOf(ctx.pluginId).toEqualTypeOf<string>();
    });

    it("PluginManifest validates with minimal fields", () => {
      const manifest: PluginManifest = {
        name: "test.plugin",
        version: "1.0.0",
        contributes: {
          panels: [],
          toolbarButtons: [],
          menuItems: [],
          views: [],
          mcpServers: [],
          forgeProviders: [],
          fileDecorationProviders: [],
        },
      };
      expectTypeOf(manifest.name).toEqualTypeOf<string>();
    });

    it("ResourceRef matches expected shape", () => {
      const ref: ResourceRef = {
        providerId: "github",
        owner: "acme",
        repo: "test",
        number: 1,
        rawData: null,
      };
      expectTypeOf(ref.number).toEqualTypeOf<number>();
    });

    it("CIStatus matches expected shape", () => {
      const status: CIStatus = {
        state: "success",
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        rawData: null,
      };
      expectTypeOf(status.state).toMatchTypeOf<string>();
    });
  });

  describe("react entry point", () => {
    it("resolves with no value exports", async () => {
      const mod = await import("../plugin-sdk-react.js");
      expect(Object.keys(mod)).toHaveLength(0);
    });
  });

  describe("host-internal types are NOT exported from SDK", () => {
    it("LoadedPluginInfo is not in the SDK barrel", () => {
      // @ts-expect-error — LoadedPluginInfo is host-internal
      const _check: import("../plugin-sdk.js").LoadedPluginInfo = null;
    });

    it("PluginActionDescriptor is not in the SDK barrel", () => {
      // @ts-expect-error — PluginActionDescriptor is host-internal
      const _check: import("../plugin-sdk.js").PluginActionDescriptor = null;
    });

    it("BUILT_IN_PLUGIN_PERMISSIONS is not in the SDK barrel", () => {
      // @ts-expect-error — BUILT_IN_PLUGIN_PERMISSIONS is host-internal
      const _check: import("../plugin-sdk.js").BUILT_IN_PLUGIN_PERMISSIONS = null;
    });
  });
});
