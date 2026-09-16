// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  current: { projectId: "p1", worktreeId: "wt-1", worktreePath: "/repo" },
}));
vi.mock("../useInspectorContext.js", () => ({ useInspectorContext: () => context.current }));

import { SiteInspectorView } from "../SiteInspectorView";
import { __resetInspectorControllersForTests, loadGuestRuntimeBody } from "../inspectorController";
import { CHANNELS, PUSH_CHANNELS } from "../../shared/protocol";
import {
  CLASS_VALUE,
  FILE,
  REVISION,
  TEXT_RANGE,
  createFakeHost,
  makeReceipt,
  makeSelection,
  type FakeHost,
} from "./testHost";

let host: FakeHost;
let uninstall: () => void;
let removed: AbortController;

function mount({ reuseSignal = false } = {}) {
  if (!reuseSignal) removed = new AbortController();
  return render(
    <SiteInspectorView
      panelId="inspector-1"
      pluginId="daintree.sveltekit-builder"
      disposeSignal={new AbortController().signal}
      panelRemovedSignal={removed.signal}
      initialArgs={{}}
      stateVersion={1}
      persistState={() => true}
      styleRootAttributes={{}}
    />
  );
}

async function mountBound() {
  mount();
  await waitFor(() => expect(host.sitePreview.bind).toHaveBeenCalled());
  await screen.findByRole("button", { name: "Browse" });
  await act(async () => host.documentReady(0));
}

async function mountSelected() {
  await mountBound();
  await act(async () => host.select(0));
  await screen.findByRole("button", { name: "Remove px-6" });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Remove px-6" }) as HTMLButtonElement).disabled
    ).toBe(false)
  );
}

function removeButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Remove px-6" }) as HTMLButtonElement;
}

function text(): string {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  context.current = { projectId: "p1", worktreeId: "wt-1", worktreePath: "/repo" };
  host = createFakeHost();
  uninstall = host.install();
});

afterEach(() => {
  cleanup();
  __resetInspectorControllersForTests();
  uninstall();
});

describe("preview binding", () => {
  it("auto-binds the only candidate with the guest runtime body", async () => {
    mount();
    await waitFor(() => expect(host.sitePreview.bind).toHaveBeenCalledTimes(1));
    const body = await loadGuestRuntimeBody();
    // The prelude-wrapped body, not the standalone script: it speaks through `api`.
    expect(body).toContain("api.post(event)");
    expect(host.sitePreview.bind.mock.calls[0]![0]).toEqual({
      panelId: "preview-1",
      runtimeSource: body,
      mode: "browse",
    });
    await screen.findByRole("button", { name: "Select" });
  });

  it("shows a picker for several candidates and binds the one chosen", async () => {
    host.setCandidates([
      { panelId: "preview-1", url: "http://localhost:5173/", boundSessionId: null },
      { panelId: "preview-2", url: "http://localhost:5174/about", boundSessionId: null },
    ]);
    mount();
    const choice = await screen.findByRole("button", { name: /localhost:5174\/about/ });
    expect(screen.getByRole("button", { name: /localhost:5173\// })).toBeTruthy();
    expect(host.sitePreview.bind).not.toHaveBeenCalled();
    fireEvent.click(choice);
    await waitFor(() => expect(host.sitePreview.bind).toHaveBeenCalledTimes(1));
    expect(host.sitePreview.bind.mock.calls[0]![0].panelId).toBe("preview-2");
  });

  it("asks for a dev preview when there is none", async () => {
    host.setCandidates([]);
    mount();
    await screen.findByText("Start a dev preview");
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(host.sitePreview.bind).not.toHaveBeenCalled();
  });

  it("switches the preview between Browse and Select", async () => {
    await mountBound();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    await waitFor(() =>
      expect(host.sitePreview.setMode).toHaveBeenCalledWith({
        sessionId: "session-1",
        mode: "select",
      })
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Select" }).getAttribute("aria-pressed")).toBe(
        "true"
      )
    );
  });

  it("offers the app choice when the worktree holds more than one app", async () => {
    host.handlers.set(CHANNELS.workspaceOpen, (args) =>
      args.appRoot
        ? {
            status: "ready",
            workspaceSessionId: "ws-1",
            appRoot: args.appRoot,
            support: { level: "full" },
          }
        : { status: "ambiguous", appRoots: ["/repo/apps/web", "/repo/apps/docs"] }
    );
    await mountBound();
    fireEvent.click(await screen.findByRole("button", { name: "apps/docs" }));
    await waitFor(() =>
      expect(host.calls(CHANNELS.workspaceOpen).at(-1)).toMatchObject({
        appRoot: "/repo/apps/docs",
      })
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "apps/docs" })).toBeNull());
  });

  it("stays preview-only when the support verdict says so", async () => {
    host.handlers.set(CHANNELS.workspaceOpen, () => ({
      status: "ready",
      workspaceSessionId: "ws-1",
      appRoot: "/repo",
      support: { level: "preview-only", reasons: ["Found svelte 4.2.1; editing needs Svelte 5"] },
    }));
    await mountBound();
    await screen.findByText("Found svelte 4.2.1; editing needs Svelte 5");
    await act(async () => host.select(0));
    await screen.findByText("Source isn't available in preview-only mode");
    expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(0);
    expect(screen.queryByRole("combobox", { name: "Add a class" })).toBeNull();
  });
});

describe("selection identity", () => {
  it("resolves a selection and renders owner, line and a breadcrumb without generated frames", async () => {
    await mountSelected();
    const [args] = host.calls(CHANNELS.selectionResolve);
    expect(args).toMatchObject({
      workspaceSessionId: "ws-1",
      previewPanelId: "preview-1",
      documentEpoch: 0,
      routeId: "/pricing",
    });
    expect((args!.nodes as unknown[]).length).toBe(1);
    expect(screen.getByText(`${FILE}:6`)).toBeTruthy();
    const crumbs = screen.getByRole("list", { name: "Ancestry" }).textContent ?? "";
    expect(crumbs).toContain("PricingCard");
    expect(crumbs).toContain("each");
    expect(crumbs).not.toContain("root");
  });

  it("warns about shared markup before any edit control", async () => {
    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: makeSelection({
        documentEpoch: args.documentEpoch as number,
        renderedOccurrences: 3,
      }),
    }));
    await mountSelected();
    const warning = screen.getByText("Affects 3 rendered copies");
    const firstControl = screen.getByRole("button", { name: "Edit text" });
    expect(
      warning.compareDocumentPosition(firstControl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(text()).not.toMatch(/this element only/i);
  });

  it("explains a surface that isn't directly editable and offers no working control", async () => {
    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: makeSelection({
        documentEpoch: args.documentEpoch as number,
        capabilities: [
          { surface: "text", support: "agent-assisted", reason: "dynamic-expression" },
          { surface: "classes", support: "inspect-only", reason: "class-directive" },
        ],
      }),
    }));
    await mountBound();
    await act(async () => host.select(0));
    await screen.findByText("Set by an expression in the source, not a literal value");
    expect(screen.getByText("Controlled by a class: directive")).toBeTruthy();
    expect(screen.getByText("Needs an agent")).toBeTruthy();
    expect(screen.getByText("Inspect only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit text" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Add a class" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove px-6" })).toBeNull();
    // Nothing to read either: an unsupported selection never asks for source.
    expect(host.calls(CHANNELS.sourceExcerpt)).toHaveLength(0);
  });
});

describe("editing", () => {
  it("adds a class against the selection's revision and does not claim the styles rendered", async () => {
    await mountSelected();
    const input = screen.getByRole("combobox", { name: "Add a class" });
    fireEvent.change(input, { target: { value: "shadow-md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));
    const [apply] = host.calls(CHANNELS.editApply);
    expect(apply).toMatchObject({
      workspaceSessionId: "ws-1",
      file: FILE,
      expectedRevision: REVISION,
      affectedOccurrences: 1,
      operations: [
        {
          kind: "set_class_tokens",
          range: CLASS_VALUE,
          add: ["shadow-md"],
          remove: [],
          responsive: { kind: "base" },
        },
      ],
    });

    await screen.findByText("Saved — preview not yet refreshed");
    expect(text()).toContain("Styles not verified");
    expect(text()).not.toMatch(/styles (generated|applied|rendered)/i);
    // The write spent the selection's ranges.
    expect(removeButton().disabled).toBe(true);

    await act(async () => host.documentReady(1));
    await screen.findByText("Saved — preview reloaded");
    expect(text()).toContain("Styles not verified");
  });

  it("reports a class main refuses by name and keeps what was typed", async () => {
    host.handlers.set(CHANNELS.editApply, () => ({
      status: "error",
      code: "INVALID_CANDIDATE",
      message: "shadow-huge isn't a class Tailwind can generate in this project",
    }));
    await mountSelected();
    const input = screen.getByRole("combobox", { name: "Add a class" });
    fireEvent.change(input, { target: { value: "shadow-huge" } });
    await screen.findByText("Not in this project's class list — it's checked when you add it");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Not saved — that class isn't valid here");
    expect(text()).not.toMatch(/Saved —/);
    expect((input as HTMLInputElement).value).toBe("shadow-huge");
  });

  it("blocks a second write while one is out, and spends a newer selection in the written file", async () => {
    await mountSelected();
    let finish: (value: unknown) => void = () => {};
    host.handlers.set(CHANNELS.editApply, () => new Promise((resolve) => (finish = resolve)));
    fireEvent.click(removeButton());
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));

    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: makeSelection({
        documentEpoch: args.documentEpoch as number,
        selectionId: "sel-2",
      }),
    }));
    await act(async () => host.select(0));
    await waitFor(() => expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(2));
    await waitFor(() => expect(host.calls(CHANNELS.sourceExcerpt)).toHaveLength(2));
    expect(removeButton().disabled).toBe(true);
    fireEvent.click(removeButton());
    expect(host.calls(CHANNELS.editApply)).toHaveLength(1);

    await act(async () => finish({ status: "applied", receipt: makeReceipt() }));
    await screen.findByText("Saved — preview not yet refreshed");
    expect(screen.getByText("Select again to keep editing")).toBeTruthy();
    expect(removeButton().disabled).toBe(true);
    expect(host.calls(CHANNELS.editApply)).toHaveLength(1);
  });

  it("removes a class through a token operation", async () => {
    await mountSelected();
    fireEvent.click(removeButton());
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));
    expect(host.calls(CHANNELS.editApply)[0]!.operations).toEqual([
      {
        kind: "set_class_tokens",
        range: CLASS_VALUE,
        add: [],
        remove: ["px-6"],
        responsive: { kind: "base" },
      },
    ]);
  });

  it("edits literal text on Enter and cancels on Escape without writing", async () => {
    await mountSelected();
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    let field = screen.getByRole("textbox", { name: "Text" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Go Pro" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Text" })).toBeNull();
    expect(host.calls(CHANNELS.editApply)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    field = screen.getByRole("textbox", { name: "Text" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Go Pro" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));
    expect(host.calls(CHANNELS.editApply)[0]!.operations).toEqual([
      { kind: "set_literal_text", range: TEXT_RANGE, text: "Go Pro" },
    ]);
    await screen.findByText("Saved — preview not yet refreshed");
    expect(text()).not.toContain("Styles not verified");
  });

  it("keeps typing inside its field instead of reaching panel shortcuts", async () => {
    await mountBound();
    cleanup();
    const panelKeys = vi.fn();
    removed = new AbortController();
    render(
      <div onKeyDown={panelKeys}>
        <SiteInspectorView
          panelId="inspector-1"
          pluginId="daintree.sveltekit-builder"
          disposeSignal={new AbortController().signal}
          panelRemovedSignal={removed.signal}
          initialArgs={{}}
          stateVersion={1}
          persistState={() => true}
          styleRootAttributes={{}}
        />
      </div>
    );
    await act(async () => host.select(0));
    const input = await screen.findByRole("combobox", { name: "Add a class" });
    fireEvent.keyDown(input, { key: "s" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(panelKeys).not.toHaveBeenCalled();
  });
});

describe("stale selections", () => {
  it("goes stale when the document epoch advances", async () => {
    await mountSelected();
    await act(async () => host.epochAdvanced(1));
    await screen.findByText("Selection changed — select again");
    expect(removeButton().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit text" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(
      (screen.getByRole("combobox", { name: "Add a class" }) as HTMLInputElement).disabled
    ).toBe(true);
  });

  it("goes stale when main reports the selected file changed, and only that file", async () => {
    await mountSelected();
    await act(async () =>
      host.pushPlugin(PUSH_CHANNELS.sourceChanged, {
        workspaceSessionId: "ws-1",
        file: "src/lib/Other.svelte",
        revision: REVISION,
      })
    );
    expect(removeButton().disabled).toBe(false);
    await act(async () =>
      host.pushPlugin(PUSH_CHANNELS.sourceChanged, {
        workspaceSessionId: "ws-1",
        file: FILE,
        revision: null,
      })
    );
    await screen.findByText("Source changed — select again");
    expect(removeButton().disabled).toBe(true);
  });

  it("keys on the event's epoch when documentReady beats epoch-advanced", async () => {
    await mountSelected();
    // The reinstalled runtime reports the new document before the bridge's push.
    await act(async () => host.documentReady(1));
    await screen.findByText("Selection changed — select again");
    await act(async () => host.select(1));
    await waitFor(() => expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(2));
    expect(host.calls(CHANNELS.selectionResolve)[1]).toMatchObject({ documentEpoch: 1 });
    await waitFor(() => expect(screen.queryByText("Selection changed — select again")).toBeNull());
    await waitFor(() => expect(removeButton().disabled).toBe(false));

    // The late push for the epoch we are already in must not invalidate anything.
    await act(async () => host.epochAdvanced(1));
    expect(screen.queryByText("Selection changed — select again")).toBeNull();
    expect(removeButton().disabled).toBe(false);
    expect(screen.getByText("/pricing")).toBeTruthy();
  });

  it("drops a resolve when the owning file changed while it was out", async () => {
    let finish: (value: unknown) => void = () => {};
    host.handlers.set(
      CHANNELS.selectionResolve,
      () => new Promise((resolve) => (finish = resolve))
    );
    await mountBound();
    await act(async () => host.select(0));
    await waitFor(() => expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(1));
    await act(async () =>
      host.pushPlugin(PUSH_CHANNELS.sourceChanged, {
        workspaceSessionId: "ws-1",
        file: FILE,
        revision: null,
      })
    );
    await act(async () => finish({ status: "ok", selection: makeSelection({ documentEpoch: 0 }) }));
    await screen.findByText("Selection changed — select again");
    expect(screen.queryByRole("button", { name: "Remove px-6" })).toBeNull();
  });

  it("takes a newer epoch from a mode switch", async () => {
    await mountSelected();
    host.sitePreview.setMode.mockImplementationOnce(async ({ mode }) => ({
      sessionId: "session-1",
      panelId: "preview-1",
      projectId: "p1",
      documentEpoch: 1,
      mode,
      guestReady: false,
      droppedMessages: 0,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    await screen.findByText("Selection changed — select again");
    expect(removeButton().disabled).toBe(true);
  });

  it("drops a resolve that finishes after the document moved on", async () => {
    let finish: (value: unknown) => void = () => {};
    host.handlers.set(
      CHANNELS.selectionResolve,
      () => new Promise((resolve) => (finish = resolve))
    );
    await mountBound();
    await act(async () => host.select(0));
    await waitFor(() => expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(1));
    await act(async () => host.epochAdvanced(1));
    await act(async () => finish({ status: "ok", selection: makeSelection({ documentEpoch: 0 }) }));
    await screen.findByText("Selection changed — select again");
    expect(screen.queryByRole("button", { name: "Remove px-6" })).toBeNull();
  });
});

describe("truthful failures and undo", () => {
  it("reports a conflict as not saved and stops editing", async () => {
    host.handlers.set(CHANNELS.editApply, () => ({
      status: "conflict",
      currentRevision: "a".repeat(64),
    }));
    await mountSelected();
    fireEvent.click(removeButton());
    await screen.findByText("Not saved — the file changed");
    expect(text()).not.toMatch(/Saved —/);
    expect(screen.queryByRole("region", { name: "Last change" })).toBeNull();
    expect(removeButton().disabled).toBe(true);
  });

  it("undoes by transaction id and reports the reversal", async () => {
    await mountSelected();
    fireEvent.click(removeButton());
    const undo = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undo);
    await waitFor(() =>
      expect(host.calls(CHANNELS.editUndo)).toEqual([
        { workspaceSessionId: "ws-1", transactionId: "tx-1" },
      ])
    );
    await screen.findByText("Undone — preview not yet refreshed");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("reports a superseded undo without claiming the edit was reversed", async () => {
    host.handlers.set(CHANNELS.editUndo, () => ({
      status: "superseded",
      currentRevision: "b".repeat(64),
    }));
    await mountSelected();
    fireEvent.click(removeButton());
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await screen.findByText("Can't undo — the file changed since this edit");
    expect(text()).not.toContain("Undone");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("lifetime", () => {
  it("keeps the binding across a remount", async () => {
    await mountSelected();
    cleanup();
    expect(host.sitePreview.detach).not.toHaveBeenCalled();
    mount({ reuseSignal: true });
    expect(screen.getByRole("button", { name: "Remove px-6" })).toBeTruthy();
    expect(host.sitePreview.bind).toHaveBeenCalledTimes(1);
  });

  it("releases the preview and workspace when the panel is removed while unmounted", async () => {
    await mountSelected();
    cleanup();
    act(() => removed.abort());
    expect(host.sitePreview.detach).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(host.calls(CHANNELS.workspaceClose)).toEqual([{ workspaceSessionId: "ws-1" }]);
  });

  it("disconnects the preview when the panel moves to another worktree", async () => {
    await mountSelected();
    cleanup();
    context.current = { projectId: "p1", worktreeId: "wt-2", worktreePath: "/repo-2" };
    mount({ reuseSignal: true });
    await waitFor(() =>
      expect(host.sitePreview.detach).toHaveBeenCalledWith({ sessionId: "session-1" })
    );
    await waitFor(() =>
      expect(host.calls(CHANNELS.workspaceOpen).at(-1)).toMatchObject({ worktreeId: "wt-2" })
    );
    expect(screen.queryByRole("button", { name: "Remove px-6" })).toBeNull();
  });
});
