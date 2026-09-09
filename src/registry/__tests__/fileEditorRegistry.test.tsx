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
} from "../fileEditorRegistry";

// The runtime mirror is a live store in this test so the enable gate can be
// driven directly; `init` is the IPC pull, which jsdom has no bridge for.
const runtime = vi.hoisted(() => {
  const noopInit = () => {};
  return {
    // Replaced wholesale on every change so useSyncExternalStore sees a new
    // snapshot exactly when something moved, and a stable one otherwise.
    state: { disabledPluginIds: new Set<string>() as ReadonlySet<string>, init: noopInit },
    listeners: new Set<() => void>(),
    noopInit,
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

function setDisabled(ids: string[]): void {
  runtime.state = { disabledPluginIds: new Set(ids), init: runtime.noopInit };
  for (const listener of runtime.listeners) listener();
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
  });
});
