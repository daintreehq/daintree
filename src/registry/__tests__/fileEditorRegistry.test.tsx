// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBuiltinRendererRegistryForTests,
  registerBuiltinView,
} from "../builtinRendererRegistry";
import {
  __resetFileEditorRegistryForTests,
  DEFAULT_FILE_EDITOR_MAX_BYTES,
  registerFileEditor,
  resolveFileEditor,
  useFileEditor,
  useResolvedFileEditor,
} from "../fileEditorRegistry";

// The runtime mirror is a live store in this test so the enable gate can be
// driven directly; `init` is the IPC pull, which jsdom has no bridge for.
const runtime = vi.hoisted(() => {
  const noopInit = () => {};
  // Explicit membership: an absent entry means "no snapshot yet", which the
  // hook treats as unavailable, so a mock that answered `has` for anything
  // could not tell the two apart.
  const known: ReadonlyMap<string, unknown> = new Map<string, unknown>([
    ["daintree.markdown-editor", { devMode: false, displayName: "Markdown editor" }],
    ["daintree.other-editor", { devMode: false, displayName: "Other editor" }],
    ["x", { devMode: false, displayName: "X" }],
  ]);
  const noneDisabled: ReadonlySet<string> = new Set<string>();
  return {
    // Replaced wholesale on every change so useSyncExternalStore sees a new
    // snapshot exactly when something moved, and a stable one otherwise.
    state: { disabledPluginIds: noneDisabled, pluginMetaById: known, init: noopInit },
    listeners: new Set<() => void>(),
    noopInit,
    known,
    noneDisabled,
  };
});
vi.mock("@/store/pluginRuntimeStore", async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import("react")>("react");
  const subscribe = (listener: () => void) => {
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  };
  const usePluginRuntimeStore = <T,>(selector: (s: typeof runtime.state) => T): T =>
    useSyncExternalStore(subscribe, () => selector(runtime.state));
  usePluginRuntimeStore.getState = () => runtime.state;
  return { usePluginRuntimeStore };
});

/**
 * Moves only what it is given: the untouched half keeps its exact instance, so
 * a case that changes metadata proves the metadata subscription rather than
 * riding on a new disabled set.
 */
function setRuntime(
  next: { disabled?: ReadonlySet<string>; known?: ReadonlyMap<string, unknown> } = {}
): void {
  runtime.state = {
    disabledPluginIds: next.disabled ?? runtime.noneDisabled,
    pluginMetaById: next.known ?? runtime.known,
    init: runtime.noopInit,
  };
  for (const listener of runtime.listeners) listener();
}

function setDisabled(ids: string[]): void {
  setRuntime({ disabled: new Set(ids) });
}

function Editor(): null {
  return null;
}

describe("fileEditorRegistry (#12323)", () => {
  beforeEach(() => {
    registerFileEditor({
      id: "markdown",
      pluginId: "daintree.markdown-editor",
      slot: "markdown.editor",
      extensions: ["md", "Markdown", "mkd"],
      maxBytes: 2048,
    });
  });

  afterEach(() => {
    __resetFileEditorRegistryForTests();
    __resetBuiltinRendererRegistryForTests();
    setDisabled([]);
  });

  describe("resolveFileEditor", () => {
    it("matches by extension, case-insensitively on both sides", () => {
      expect(resolveFileEditor("/repo/docs/plan.md")?.id).toBe("markdown");
      expect(resolveFileEditor("/repo/README.MD")?.id).toBe("markdown");
      expect(resolveFileEditor("C:\\repo\\notes.markdown")?.id).toBe("markdown");
    });

    it("refuses MDX, other extensions, dotfiles and bare names", () => {
      expect(resolveFileEditor("/repo/page.mdx")).toBeNull();
      expect(resolveFileEditor("/repo/index.ts")).toBeNull();
      expect(resolveFileEditor("/repo/.md")).toBeNull();
      expect(resolveFileEditor("/repo/README")).toBeNull();
      expect(resolveFileEditor("/repo/trailing.")).toBeNull();
    });

    it("defaults maxBytes when a registration omits it", () => {
      __resetFileEditorRegistryForTests();
      registerFileEditor({ id: "txt", pluginId: "x", slot: "x.editor", extensions: ["txt"] });
      expect(resolveFileEditor("/a.txt")?.maxBytes).toBe(DEFAULT_FILE_EDITOR_MAX_BYTES);
    });

    it("unregisters through the returned disposer", () => {
      const dispose = registerFileEditor({
        id: "txt",
        pluginId: "x",
        slot: "x.editor",
        extensions: ["txt"],
      });
      expect(resolveFileEditor("/a.txt")).not.toBeNull();
      dispose();
      expect(resolveFileEditor("/a.txt")).toBeNull();
    });
  });

  describe("useFileEditor", () => {
    it("resolves null when no plugin claims the extension", () => {
      registerBuiltinView("markdown.editor", Editor, { pluginId: "daintree.markdown-editor" });
      const { result } = renderHook(() => useFileEditor("/repo/index.ts"));
      expect(result.current).toBeNull();
    });

    it("resolves null for an undefined path without touching the registry", () => {
      const { result } = renderHook(() => useFileEditor(undefined));
      expect(result.current).toBeNull();
    });

    it("resolves null when the slot was never registered (manifest/renderer drift)", () => {
      const { result } = renderHook(() => useFileEditor("/repo/plan.md"));
      expect(result.current).toBeNull();
    });

    it("hands back the registration and the slot component, and drops it live on disable", () => {
      registerBuiltinView("markdown.editor", Editor, { pluginId: "daintree.markdown-editor" });
      const { result } = renderHook(() => useFileEditor("/repo/plan.md"));
      expect(result.current?.registration.maxBytes).toBe(2048);
      expect(typeof result.current?.Component).toBe("function");

      act(() => setDisabled(["daintree.markdown-editor"]));
      expect(result.current).toBeNull();

      act(() => setDisabled([]));
      expect(result.current?.registration.id).toBe("markdown");
    });

    it("hides the editor while the owning plugin is not in the runtime snapshot yet", () => {
      registerBuiltinView("markdown.editor", Editor, { pluginId: "daintree.markdown-editor" });
      setRuntime({ known: new Map() });
      const { result } = renderHook(() => useFileEditor("/repo/plan.md"));
      expect(result.current).toBeNull();

      // Only the metadata moved — the disabled set is the very same instance.
      act(() => setRuntime());
      expect(result.current?.registration.id).toBe("markdown");
    });
  });

  describe("useResolvedFileEditor", () => {
    it("answers as the non-reactive route does, keeping the disabled fallback", () => {
      const { result } = renderHook(() => useResolvedFileEditor("/repo/plan.md"));
      expect(result.current?.id).toBe("markdown");
      expect(result.current?.maxBytes).toBe(2048);

      act(() => setDisabled(["daintree.markdown-editor"]));
      // Still the claimant: the banner's whole job is to offer to enable it.
      expect(result.current?.id).toBe("markdown");
    });

    it("re-resolves when the runtime mirror moves rather than snapshotting it", () => {
      const second = "daintree.other-editor";
      registerFileEditor({
        id: "other",
        pluginId: second,
        slot: "other.editor",
        extensions: ["md"],
      });
      registerBuiltinView("markdown.editor", Editor, { pluginId: "daintree.markdown-editor" });
      registerBuiltinView("other.editor", Editor, { pluginId: second });

      const { result } = renderHook(() => useResolvedFileEditor("/repo/plan.md"));
      expect(result.current?.id).toBe("markdown");

      // A Preferences toggle: an unsubscribed getState() read would sit here.
      act(() => setDisabled(["daintree.markdown-editor"]));
      expect(result.current?.id).toBe("other");

      act(() => setDisabled([]));
      expect(result.current?.id).toBe("markdown");
    });

    it("resolves null when nothing claims the extension", () => {
      const { result } = renderHook(() => useResolvedFileEditor("/repo/index.ts"));
      expect(result.current).toBeNull();
    });
  });

  describe("competing registrations for one extension", () => {
    const second = "daintree.other-editor";

    beforeEach(() => {
      registerFileEditor({
        id: "other",
        pluginId: second,
        slot: "other.editor",
        extensions: ["md"],
        maxBytes: 4096,
      });
      registerBuiltinView("markdown.editor", Editor, { pluginId: "daintree.markdown-editor" });
      registerBuiltinView("other.editor", Editor, { pluginId: second });
    });

    it("prefers the first registration while both are enabled", () => {
      const { result } = renderHook(() => useFileEditor("/repo/plan.md"));
      expect(result.current?.registration.id).toBe("markdown");
      expect(resolveFileEditor("/repo/plan.md")?.id).toBe("markdown");
    });

    it("falls through to the later candidate when the first is disabled", () => {
      setDisabled(["daintree.markdown-editor"]);
      const { result } = renderHook(() => useFileEditor("/repo/plan.md"));
      expect(result.current?.registration.id).toBe("other");
      expect(resolveFileEditor("/repo/plan.md")?.id).toBe("other");

      // And back again, live, when the first one returns.
      act(() => setDisabled([]));
      expect(result.current?.registration.id).toBe("markdown");
    });

    it("skips a candidate whose slot was never registered", () => {
      __resetBuiltinRendererRegistryForTests();
      registerBuiltinView("other.editor", Editor, { pluginId: second });
      const { result } = renderHook(() => useFileEditor("/repo/plan.md"));
      expect(result.current?.registration.id).toBe("other");
    });

    it("keeps the enable route on a disabled candidate when the enabled one has no slot", () => {
      // B is enabled but its renderer entry never registered, so the only
      // editor a user can actually reach is A's — behind its enable toggle.
      __resetBuiltinRendererRegistryForTests();
      registerBuiltinView("markdown.editor", Editor, { pluginId: "daintree.markdown-editor" });
      setDisabled(["daintree.markdown-editor"]);
      const { result } = renderHook(() => useFileEditor("/repo/plan.md"));
      expect(result.current).toBeNull();
      expect(resolveFileEditor("/repo/plan.md")?.id).toBe("markdown");
    });

    it("resolves null once every candidate is disabled", () => {
      setDisabled(["daintree.markdown-editor", second]);
      const { result } = renderHook(() => useFileEditor("/repo/plan.md"));
      expect(result.current).toBeNull();
      // The non-reactive route still reports a claimant, so the enable banner
      // has something to offer.
      expect(resolveFileEditor("/repo/plan.md")?.id).toBe("markdown");
    });
  });
});
