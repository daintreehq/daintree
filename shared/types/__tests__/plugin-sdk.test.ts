import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  PluginManifest,
  PluginHostApi,
  PluginActivationApi,
  PluginSettingsScope,
  PluginStorageScope,
  PluginHostCallOptions,
  PluginActivate,
  PanelContribution,
  ToolbarButtonContribution,
  PluginPanelBadge,
  PluginPanelBadgeColor,
  MenuItemContribution,
  MenuItemLocation,
  ViewContribution,
  ViewLocation,
  PanelViewProps,
  PluginPanelLifecycleEvent,
  PluginPanelLifecyclePhase,
  McpServerContribution,
  PluginCapability,
  BuiltInPluginCapability,
  PluginActionContribution,
  PluginWorktreeSnapshot,
  PluginWorktreeLinked,
  PluginWorktreeLinkedIssue,
  PluginWorktreeLinkedPR,
  PluginWorktreeStatus,
  PluginWorktreeStatusFile,
  PluginWorktreeFileState,
  PluginIpcContext,
  PluginIpcHandler,
  PluginProcessApi,
  PluginProcessHandle,
  PluginDuplexProcessHandle,
  PluginPtyProcessHandle,
  PluginProcessDataChunk,
  PluginProcessSpawnOptions,
  ForgeProviderImpl,
  ForgeProviderDescriptor,
  ForgeProviderContribution,
  ForgeProviderKind,
  FileDecorationProviderImpl,
  FileDecorationProviderDescriptor,
  FileDecorationContribution,
  NormalizedPRState,
  ResourceRef,
  CIStatus,
  Issue,
  PR,
  RepoRef,
  Page,
  Credentials,
  AuthValidation,
  FetchOptions,
  ListOptions,
  RepoMetadata,
  CreateIssueInput,
  ForgeUser,
  ForgeLabel,
  NormalizedIssueState,
  RateLimitInfo,
  FileDecoration,
  ChecksCapability,
  CheckRun,
  CheckRunStatus,
  CheckRunConclusion,
  PluginProcessStreamEvent,
  ActionDispatchResult,
  ActionDispatchSuccess,
  ActionDispatchError,
  ActionError,
  ActionErrorCode,
  PluginHostActionsApi,
  PluginActionManifestEntry,
  PluginCanDispatchResult,
  BuiltInActionId,
  ActionId,
  ActionKind,
  ActionDanger,
  ActionExample,
} from "../plugin-sdk.js";
import { PLUGIN_PROCESS_STREAM_CHANNEL, localAuthStubs } from "../plugin-sdk.js";
import type { UseHostChannelResult, PluginEventHandler } from "../plugin-sdk-react.js";

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
      expectTypeOf<PluginPanelBadge>().toMatchTypeOf<object>();
      expectTypeOf<PluginPanelBadgeColor>().toMatchTypeOf<string>();
      expectTypeOf<MenuItemContribution>().toMatchTypeOf<object>();
      expectTypeOf<MenuItemLocation>().toMatchTypeOf<string>();
      expectTypeOf<ViewContribution>().toMatchTypeOf<object>();
      expectTypeOf<ViewLocation>().toMatchTypeOf<string>();
      expectTypeOf<PanelViewProps>().toMatchTypeOf<object>();
      expectTypeOf<McpServerContribution>().toMatchTypeOf<object>();
      expectTypeOf<PluginCapability>().toMatchTypeOf<string>();
      expectTypeOf<BuiltInPluginCapability>().toMatchTypeOf<string>();
      expectTypeOf<PluginActionContribution>().toMatchTypeOf<object>();
    });

    it("exports manifest root", () => {
      expectTypeOf<PluginManifest>().toMatchTypeOf<object>();
    });

    it("exports activation contract", () => {
      expectTypeOf<PluginActivate>().toMatchTypeOf<(...args: never[]) => unknown>();
      expectTypeOf<PluginHostApi>().toMatchTypeOf<object>();
      expectTypeOf<PluginActivationApi>().toMatchTypeOf<object>();
    });

    it("exports IPC types", () => {
      expectTypeOf<PluginIpcContext>().toMatchTypeOf<object>();
      expectTypeOf<PluginIpcHandler>().toMatchTypeOf<(...args: never[]) => unknown>();
    });

    it("exports managed-process contract", () => {
      expectTypeOf<PluginProcessApi>().toMatchTypeOf<object>();
      expectTypeOf<PluginProcessHandle>().toMatchTypeOf<object>();
      expectTypeOf<PluginDuplexProcessHandle>().toMatchTypeOf<object>();
      expectTypeOf<PluginProcessSpawnOptions>().toMatchTypeOf<object>();
    });

    it("exports worktree projections", () => {
      expectTypeOf<PluginWorktreeSnapshot>().toMatchTypeOf<object>();
      expectTypeOf<PluginWorktreeLinked>().toMatchTypeOf<object>();
      expectTypeOf<PluginWorktreeLinkedIssue>().toMatchTypeOf<object>();
      expectTypeOf<PluginWorktreeLinkedPR>().toMatchTypeOf<object>();
      expectTypeOf<PluginWorktreeStatus>().toMatchTypeOf<object>();
      expectTypeOf<PluginWorktreeStatusFile>().toMatchTypeOf<object>();
      expectTypeOf<PluginWorktreeFileState>().toMatchTypeOf<string>();
    });

    it("exports forge provider contract", () => {
      expectTypeOf<ForgeProviderImpl>().toMatchTypeOf<object>();
      expectTypeOf<ForgeProviderDescriptor>().toMatchTypeOf<object>();
      expectTypeOf<ForgeProviderContribution>().toMatchTypeOf<object>();
      expectTypeOf<ForgeProviderKind>().toEqualTypeOf<"local" | "network">();
    });

    it("exports localAuthStubs as a runtime value (#10563)", () => {
      // Value export, not type-only — a local/offline provider spreads it into
      // its impl at runtime, so a type-only re-export would emit `undefined`.
      expect(typeof localAuthStubs.getCredentials).toBe("function");
      expect(typeof localAuthStubs.validateCredentials).toBe("function");
      expect(typeof localAuthStubs.validateToken).toBe("function");
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

    it("exports forge domain types for provider authoring", () => {
      expectTypeOf<Issue>().toMatchTypeOf<object>();
      expectTypeOf<PR>().toMatchTypeOf<object>();
      expectTypeOf<RepoRef>().toMatchTypeOf<object>();
      expectTypeOf<Page<unknown>>().toMatchTypeOf<object>();
      expectTypeOf<Credentials>().toMatchTypeOf<object>();
      expectTypeOf<AuthValidation>().toMatchTypeOf<object>();
      expectTypeOf<FetchOptions>().toMatchTypeOf<object>();
      expectTypeOf<ListOptions>().toMatchTypeOf<object>();
      expectTypeOf<RepoMetadata>().toMatchTypeOf<object>();
      expectTypeOf<CreateIssueInput>().toMatchTypeOf<object>();
      expectTypeOf<ForgeUser>().toMatchTypeOf<object>();
      expectTypeOf<ForgeLabel>().toMatchTypeOf<object>();
      expectTypeOf<NormalizedIssueState>().toMatchTypeOf<string>();
      expectTypeOf<RateLimitInfo>().toMatchTypeOf<object>();
      expectTypeOf<FileDecoration>().toMatchTypeOf<object>();
    });

    it("exports the optional checks capability and its check vocabulary", () => {
      // A third-party forge provider implementing `checks` must be able to name
      // the capability and the union members it returns without reaching into
      // internal app paths — otherwise only the builtin can implement it.
      expectTypeOf<ChecksCapability>().toMatchTypeOf<object>();
      expectTypeOf<CheckRun>().toMatchTypeOf<object>();
      expectTypeOf<CheckRunStatus>().toMatchTypeOf<string>();
      expectTypeOf<CheckRunConclusion>().toMatchTypeOf<string>();
    });

    it("exports the process-stream event type and channel constant", () => {
      expectTypeOf<PluginProcessStreamEvent>().toMatchTypeOf<object>();
      // PLUGIN_PROCESS_STREAM_CHANNEL is a value export, not type-only — it must
      // survive to runtime so `plugin.on(pluginId, PLUGIN_PROCESS_STREAM_CHANNEL)`
      // resolves the real channel string.
      expect(typeof PLUGIN_PROCESS_STREAM_CHANNEL).toBe("string");
      expectTypeOf(PLUGIN_PROCESS_STREAM_CHANNEL).toEqualTypeOf<"process">();
    });

    it("exports the host.dispatch result types", () => {
      // host.dispatch() resolves to ActionDispatchResult; a plugin author must be
      // able to name it and its error-code union from the public SDK.
      expectTypeOf<ActionDispatchResult>().toMatchTypeOf<object>();
      expectTypeOf<ActionDispatchSuccess>().toMatchTypeOf<object>();
      expectTypeOf<ActionDispatchError>().toMatchTypeOf<object>();
      expectTypeOf<ActionError>().toMatchTypeOf<object>();
      expectTypeOf<ActionErrorCode>().toMatchTypeOf<string>();
    });

    it("exports the built-in action catalog types (#10561)", () => {
      // host.actions.list()/get() project the manifest; the dispatch surface is
      // typed against ActionId, which autocompletes built-ins while staying open
      // to plugin-authored ids (#10581).
      expectTypeOf<PluginHostActionsApi>().toMatchTypeOf<object>();
      expectTypeOf<PluginActionManifestEntry>().toMatchTypeOf<object>();
      expectTypeOf<PluginCanDispatchResult>().toMatchTypeOf<string>();
      expectTypeOf<BuiltInActionId>().toMatchTypeOf<string>();
      // ActionId is the open union (BuiltInActionId | (string & {})) used by the
      // dispatch surface — narrow enough to autocomplete built-ins, open enough
      // to still accept a plugin-authored id without a cast (#10581).
      expectTypeOf<ActionId>().toMatchTypeOf<string>();
      expectTypeOf<BuiltInActionId>().toMatchTypeOf<ActionId>();
      expectTypeOf<ActionKind>().toMatchTypeOf<string>();
      expectTypeOf<ActionDanger>().toMatchTypeOf<string>();
      expectTypeOf<ActionExample>().toMatchTypeOf<object>();
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

    it("PluginHostApi.getWorktreeStatus takes a path and returns the status projection or null", () => {
      const host = {} as PluginHostApi;
      expectTypeOf(host.getWorktreeStatus).toEqualTypeOf<
        (path: string, options?: PluginHostCallOptions) => Promise<PluginWorktreeStatus | null>
      >();
    });

    it("PluginHostApi.storage exposes get/set/delete/onDidChange", () => {
      // Purely type-level — `{} as PluginHostApi` has no runtime `storage`, so
      // dereferencing it would throw; assert on the types directly.
      expectTypeOf<PluginHostApi["storage"]["get"]>().toBeFunction();
      expectTypeOf<PluginHostApi["storage"]["set"]>().toBeFunction();
      expectTypeOf<PluginHostApi["storage"]["delete"]>().toBeFunction();
      expectTypeOf<PluginHostApi["storage"]["onDidChange"]>().toBeFunction();
      // The disposer return type guards against a regression to void / a
      // non-promise disposer, matching the settings.onDidChange contract.
      expectTypeOf<ReturnType<PluginHostApi["storage"]["onDidChange"]>>().toEqualTypeOf<
        Promise<() => void>
      >();
    });

    it("PluginStorageScope adds 'worktree' beyond the settings scopes", () => {
      // "worktree" is assignable to the storage scope but not the settings scope —
      // the two are intentionally distinct so the settings UI never sees it.
      expectTypeOf<"worktree">().toMatchTypeOf<PluginStorageScope>();
      expectTypeOf<PluginSettingsScope>().toMatchTypeOf<PluginStorageScope>();
      expectTypeOf<"worktree">().not.toMatchTypeOf<PluginSettingsScope>();
    });

    it("PluginHostApi.actions exposes the built-in catalog surface (#10561)", () => {
      // Pure type-level indexed access — `actions` is a nested object, so a value
      // access (`host.actions.list`) on an empty `{} as PluginHostApi` would throw
      // at runtime when `expectTypeOf` evaluates its argument.
      expectTypeOf<PluginHostApi["actions"]>().toEqualTypeOf<PluginHostActionsApi>();
      expectTypeOf<PluginHostApi["actions"]["list"]>().toEqualTypeOf<
        () => Promise<PluginActionManifestEntry[]>
      >();
      expectTypeOf<PluginHostApi["actions"]["get"]>().toEqualTypeOf<
        (actionId: ActionId) => Promise<PluginActionManifestEntry | null>
      >();
      expectTypeOf<PluginHostApi["actions"]["canDispatch"]>().toEqualTypeOf<
        (actionId: ActionId) => Promise<PluginCanDispatchResult>
      >();
    });

    it("PluginHostApi.dispatch accepts a BuiltInActionId and the open ActionId union (#10581)", () => {
      // dispatch is typed against ActionId, so a built-in id autocompletes and a
      // plugin-authored id (a plain string) still type-checks without a cast.
      expectTypeOf<PluginHostApi["dispatch"]>().toEqualTypeOf<
        (actionId: ActionId, args?: unknown) => Promise<ActionDispatchResult>
      >();
      expectTypeOf<BuiltInActionId>().toMatchTypeOf<Parameters<PluginHostApi["dispatch"]>[0]>();
      expectTypeOf<string>().toMatchTypeOf<Parameters<PluginHostApi["dispatch"]>[0]>();

      // Compile-only: the body is type-checked by tsc but never invoked, so the
      // value access on `{} as PluginHostApi` (whose `actions`/`dispatch` are
      // undefined at runtime) never throws.
      const _typeChecks = (host: PluginHostApi, entry: PluginActionManifestEntry) => {
        // The union is open to strings but still rejects non-string ids — guards
        // against a regression to `unknown`/`any` on the param.
        // @ts-expect-error — a numeric id is not an ActionId
        void host.dispatch(42);
        // A catalog entry's id round-trips back into dispatch/get/canDispatch
        // with no cast — the reason PluginActionManifestEntry.id is ActionId.
        void host.dispatch(entry.id);
        void host.actions.get(entry.id);
        void host.actions.canDispatch(entry.id);
      };
      void _typeChecks;
    });

    it("PluginCanDispatchResult is the three-state pre-flight verdict", () => {
      expectTypeOf("ok" as const).toMatchTypeOf<PluginCanDispatchResult>();
      expectTypeOf("confirm" as const).toMatchTypeOf<PluginCanDispatchResult>();
      expectTypeOf("restricted" as const).toMatchTypeOf<PluginCanDispatchResult>();
      // @ts-expect-error — an arbitrary verdict is not part of the union
      const _bad: PluginCanDispatchResult = "maybe";
      void _bad;
    });

    it("PluginActionManifestEntry drops renderer-internal manifest fields", () => {
      const entry = {} as PluginActionManifestEntry;
      // `id` is the open ActionId union so it round-trips straight into
      // host.dispatch()/get()/canDispatch() without a cast (#10581).
      expectTypeOf(entry.id).toEqualTypeOf<ActionId>();
      expectTypeOf(entry.danger).toEqualTypeOf<ActionDanger>();
      expectTypeOf(entry.requiresArgs).toEqualTypeOf<boolean>();
      // @ts-expect-error — `enabled` is live renderer-context state, not on the projection
      const _enabled = entry.enabled;
      // @ts-expect-error — `name` is the MCP alias, not on the projection
      const _name = entry.name;
      // @ts-expect-error — palette state is renderer-only, not on the projection
      const _paletteHidden = entry.paletteHidden;
      // @ts-expect-error — mcpVisibility is MCP-internal, not on the projection
      const _mcpVisibility = entry.mcpVisibility;
      void [_enabled, _name, _paletteHidden, _mcpVisibility];
    });

    it("PluginHostApi extends the revoke-guarded PluginActivationApi", () => {
      // The full host surface is assignable to the activation slice, but not
      // vice versa — PluginHostApi adds the post-activation-safe methods.
      expectTypeOf<PluginHostApi>().toMatchTypeOf<PluginActivationApi>();
      expectTypeOf<PluginActivationApi>().not.toMatchTypeOf<PluginHostApi>();
    });

    it("PluginActivationApi carries the revoke-guarded registration methods", () => {
      const activation = {} as PluginActivationApi;
      expectTypeOf(activation.registerAction).toBeFunction();
      expectTypeOf(activation.registerHandler).toBeFunction();
      expectTypeOf(activation.broadcastToRenderer).toBeFunction();
      expectTypeOf(activation.registerForgeProvider).toBeFunction();
      expectTypeOf(activation.registerFileDecorationProvider).toBeFunction();
      // Worktree subscriptions are revoke-guarded too (subscribing is an
      // activation-window op), so they belong on the slice.
      expectTypeOf(activation.onDidChangeActiveWorktree).toBeFunction();
      expectTypeOf(activation.onDidChangeWorktrees).toBeFunction();
      // The provider registrars resolve to a disposer — guard the return type so
      // a signature regression (to `void`, or to a non-promise disposer) is caught.
      expectTypeOf(activation.registerForgeProvider).returns.toEqualTypeOf<Promise<() => void>>();
      expectTypeOf(activation.registerFileDecorationProvider).returns.toEqualTypeOf<
        Promise<() => void>
      >();
    });

    it("PluginActivationApi excludes the post-activation-safe methods", () => {
      const activation = {} as PluginActivationApi;
      // @ts-expect-error — showToast is post-activation-safe, not on the slice
      const _showToast = activation.showToast;
      // @ts-expect-error — dispatch is post-activation-safe, not on the slice
      const _dispatch = activation.dispatch;
      // @ts-expect-error — logger is post-activation-safe, not on the slice
      const _logger = activation.logger;
      // @ts-expect-error — invalidateFileDecorations is not on the slice
      const _invalidate = activation.invalidateFileDecorations;
      // @ts-expect-error — pluginId is not on the slice
      const _pluginId = activation.pluginId;
      // @ts-expect-error — getActiveWorktree (the accessor) is not on the slice
      const _getActive = activation.getActiveWorktree;
      // @ts-expect-error — getWorktrees (the accessor) is not on the slice
      const _getAll = activation.getWorktrees;
      // @ts-expect-error — settings accessor is not on the slice
      const _settings = activation.settings;
      // @ts-expect-error — storage accessor is not on the slice
      const _storage = activation.storage;
      // @ts-expect-error — process accessor is post-activation-safe, not on the slice
      const _process = activation.process;
      expect([
        _showToast,
        _dispatch,
        _logger,
        _invalidate,
        _pluginId,
        _getActive,
        _getAll,
        _settings,
        _storage,
        _process,
      ]).toHaveLength(10);
    });

    it("PluginProcessHandle carries the lifecycle controls", () => {
      const handle = {} as PluginProcessHandle;
      expectTypeOf(handle.id).toEqualTypeOf<string>();
      expectTypeOf(handle.kill).toEqualTypeOf<() => void>();
      expectTypeOf(handle.restart).toEqualTypeOf<() => Promise<void>>();
      expectTypeOf(handle.onExit).toBeFunction();
      expectTypeOf(handle.onCrash).toBeFunction();
      // The lifecycle subscriptions hand back a disposer.
      expectTypeOf(handle.onExit).returns.toEqualTypeOf<() => void>();
      expectTypeOf(handle.onCrash).returns.toEqualTypeOf<() => void>();
    });

    it("PluginProcessApi.spawn narrows its handle on the mode literal", () => {
      // Never invoked — `expectTypeOf` erases to nothing but its ARGUMENT is
      // still evaluated at runtime, and `{} as PluginProcessApi` has no real
      // `spawn`. Keeping the assertions inside an uncalled closure makes this a
      // pure compile-time check.
      const assertTypes = async (api: PluginProcessApi): Promise<void> => {
        // Omitted mode and an explicit "pipe" both stay on the base handle — the
        // pipe process has no writable input to expose.
        expectTypeOf(await api.spawn("cmd")).toEqualTypeOf<PluginProcessHandle>();
        expectTypeOf(await api.spawn("cmd", { mode: "pipe" })).toEqualTypeOf<PluginProcessHandle>();
        // A literal `mode: "pty"` selects the interactive overload.
        expectTypeOf(
          await api.spawn("cmd", { mode: "pty" })
        ).toEqualTypeOf<PluginPtyProcessHandle>();
        // …and `mode: "duplex"` selects the writable-stdio overload (#11871),
        // which must NOT collapse into either neighbour.
        expectTypeOf(
          await api.spawn("cmd", { mode: "duplex" })
        ).toEqualTypeOf<PluginDuplexProcessHandle>();
      };
      // Compile-time only: `assertTypes` is deliberately never invoked (its
      // `expectTypeOf` arguments would be evaluated against an empty object).
      // `void` keeps it referenced without asserting something trivially true.
      void assertTypes;
    });

    it("gates write on a writable handle and resize on a PTY handle", () => {
      const pipeHandle = {} as PluginProcessHandle;
      const duplexHandle = {} as PluginDuplexProcessHandle;
      const ptyHandle = {} as PluginPtyProcessHandle;
      const assertNoPipeWrite = (handle: PluginProcessHandle): void => {
        // @ts-expect-error — a pipe-mode process has no writable stdin
        handle.write("x");
      };
      void assertNoPipeWrite;
      const assertNoDuplexResize = (handle: PluginDuplexProcessHandle): void => {
        // @ts-expect-error — a duplex child has no terminal to resize
        handle.resize(80, 24);
      };
      void assertNoDuplexResize;
      // `write` is the shared contract of both writable backends…
      expectTypeOf(duplexHandle.write).toEqualTypeOf<(data: string) => void>();
      expectTypeOf(ptyHandle.write).toEqualTypeOf<(data: string) => void>();
      // …so a PTY handle satisfies the duplex contract, while the reverse fails.
      expectTypeOf(ptyHandle).toMatchTypeOf<PluginDuplexProcessHandle>();
      expectTypeOf(duplexHandle).not.toMatchTypeOf<PluginPtyProcessHandle>();
      // …and `resize` remains PTY-only.
      expectTypeOf(ptyHandle.resize).toEqualTypeOf<(cols: number, rows: number) => void>();
      // onData is on the BASE handle: a pipe-mode plugin must be able to read
      // its own child's stdout/stderr, not just stream it to panels.
      expectTypeOf(pipeHandle.onData).returns.toEqualTypeOf<() => void>();
      expectTypeOf(pipeHandle.onData)
        .parameter(0)
        .toEqualTypeOf<(chunk: PluginProcessDataChunk) => void>();
    });

    it("PanelViewProps exposes the host-provided view props", () => {
      const props = {} as PanelViewProps;
      expectTypeOf(props.panelId).toEqualTypeOf<string>();
      expectTypeOf(props.pluginId).toEqualTypeOf<string>();
      expectTypeOf(props.disposeSignal).toEqualTypeOf<AbortSignal>();
      // Two distinct lifetimes, both public (#11301): the view attempt and the
      // panel record. A view that only ever sees one of them cannot tell a
      // temporary unmount from a permanent close.
      expectTypeOf(props.panelRemovedSignal).toEqualTypeOf<AbortSignal>();
      // Optional: a panel can be spawned without a worktree (#11297).
      expectTypeOf(props.worktreeId).toEqualTypeOf<string | undefined>();
    });

    it("exposes the panel lifecycle contract as named SDK types", () => {
      // Named exports, not just structural presence: the docs tell authors to
      // `import type { PluginPanelLifecycleEvent } from "@daintreehq/plugin-sdk"`.
      const event = {} as PluginPanelLifecycleEvent;
      expectTypeOf(event.panelId).toEqualTypeOf<string>();
      expectTypeOf(event.panelKindId).toEqualTypeOf<string>();
      expectTypeOf(event.pluginId).toEqualTypeOf<string>();
      expectTypeOf(event.phase).toEqualTypeOf<PluginPanelLifecyclePhase>();
      expectTypeOf<"removed">().toMatchTypeOf<PluginPanelLifecyclePhase>();
      expectTypeOf<"hidden">().toMatchTypeOf<PluginPanelLifecyclePhase>();
    });

    it("PluginActivationApi revoke-guards the panel lifecycle subscription", () => {
      const activation = {} as PluginActivationApi;
      expectTypeOf(activation.onDidChangePanelLifecycle).toBeFunction();
      expectTypeOf(activation.onDidChangePanelLifecycle).returns.toEqualTypeOf<
        Promise<() => void>
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
          commands: [],
          views: [],
          mcpServers: [],
          skills: [],
          keybindings: [],
          contextMenus: [],
          forgeProviders: [],
          fileDecorationProviders: [],
          agents: [],
          processTools: [],
          recipes: [],
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

    it("forge-provider helpers can be typed entirely against the SDK", () => {
      // The issue's acceptance criterion: an author writes named toIssue/toPR
      // helpers and provider methods using only @daintreehq/plugin-sdk imports,
      // with no relative internal paths.
      function toIssue(node: unknown): Issue {
        return node as Issue;
      }
      function toPR(node: unknown): PR {
        return node as PR;
      }
      const listIssues = (_repo: RepoRef, _opts?: ListOptions): Promise<Page<Issue>> =>
        Promise.resolve({} as Page<Issue>);
      const createIssue = (_repo: RepoRef, _input: CreateIssueInput): Promise<Issue> =>
        Promise.resolve({} as Issue);
      expectTypeOf(toIssue).returns.toEqualTypeOf<Issue>();
      expectTypeOf(toPR).returns.toEqualTypeOf<PR>();
      expectTypeOf(listIssues).returns.toEqualTypeOf<Promise<Page<Issue>>>();
      expectTypeOf(createIssue).returns.toEqualTypeOf<Promise<Issue>>();

      // A no-cast literal proves Issue still carries its required-field contract
      // (would compile even if Issue were broadened to `any`/`{}` — the casts
      // above wouldn't catch that).
      const issue: Issue = {
        number: 1,
        title: "t",
        body: "b",
        state: "open",
        rawState: "OPEN",
        url: "https://example.test/1",
        assignees: [],
        labels: [],
        createdAt: 0,
        updatedAt: 0,
        rawData: null,
      };
      expectTypeOf(issue.state).toEqualTypeOf<NormalizedIssueState>();
    });

    it("PluginProcessStreamEvent discriminates on kind", () => {
      const onEvent = (event: PluginProcessStreamEvent): string => {
        switch (event.kind) {
          case "stdout":
          case "stderr":
          // A PTY has one combined stream, so interactive output arrives as
          // `data` rather than the stdout/stderr pair.
          // eslint-disable-next-line no-fallthrough
          case "data":
            return event.chunk;
          case "exit":
          case "crash":
            return event.signal ?? String(event.exitCode);
        }
      };
      expectTypeOf(onEvent).parameter(0).toEqualTypeOf<PluginProcessStreamEvent>();
      expectTypeOf<PluginProcessStreamEvent["kind"]>().toEqualTypeOf<
        "stdout" | "stderr" | "data" | "exit" | "crash"
      >();

      // Per-variant payload guards — the chunk/exit fields must stay bound to
      // their own kinds (catches an accidental union merge that would let a
      // stdout event carry exitCode or an exit event carry chunk).
      // @ts-expect-error — stdout carries a chunk, not exitCode
      const _badStdout: PluginProcessStreamEvent = { kind: "stdout", id: "x", exitCode: 0 };
      // @ts-expect-error — exit carries exitCode/signal, not chunk
      const _badExit: PluginProcessStreamEvent = { kind: "exit", id: "x", chunk: "" };
      void _badStdout;
      void _badExit;
    });
  });

  describe("react entry point", () => {
    it("the type module carries no value exports — types only", async () => {
      // The `@daintreehq/plugin-sdk/react` *types* still live here; the runtime
      // hooks ship from the package's own react entry (asserted below).
      const mod = await import("../plugin-sdk-react.js");
      expect(Object.keys(mod)).toHaveLength(0);
    });

    it("exports the public hook types", () => {
      expectTypeOf<UseHostChannelResult<unknown, unknown>>().toMatchTypeOf<object>();
      expectTypeOf<PluginEventHandler<unknown>>().toMatchTypeOf<(...args: never[]) => unknown>();
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

    it("BUILT_IN_PLUGIN_CAPABILITIES is not in the SDK barrel", () => {
      // @ts-expect-error — BUILT_IN_PLUGIN_CAPABILITIES is host-internal
      const _check: import("../plugin-sdk.js").BUILT_IN_PLUGIN_CAPABILITIES = null;
    });

    it("PluginProcessInfo is not in the SDK barrel", () => {
      // The process-stream event type and channel constant are SDK-public, but
      // the renderer-IPC observability snapshot stays host-internal.
      // @ts-expect-error — PluginProcessInfo is host-internal
      const _check: import("../plugin-sdk.js").PluginProcessInfo = null;
    });

    it("PluginProcessStatus is not in the SDK barrel", () => {
      // @ts-expect-error — PluginProcessStatus is host-internal
      const _check: import("../plugin-sdk.js").PluginProcessStatus = null;
    });
  });
});
