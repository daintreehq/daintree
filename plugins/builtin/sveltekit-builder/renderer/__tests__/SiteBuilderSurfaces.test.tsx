// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  current: { projectId: "p1", worktreeId: "wt-1", worktreePath: "/repo" },
}));

import { SiteBuilderDrawer, SiteBuilderToolbar } from "../SiteBuilderSurfaces";
import {
  __resetInspectorControllersForTests,
  loadGuestRuntimeBody,
  peekBuilderController,
  releaseBuilderController,
} from "../inspectorController";
import { CHANNELS, PLUGIN_ID, PUSH_CHANNELS } from "../../shared/protocol";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import {
  __resetComposerMemoryForTests,
  composerMemoryKey,
  updateComposerMemory,
} from "../composerMemory";
import { usePanelStore } from "@/store/panelStore";
import {
  BUTTON_RANGE,
  FILE,
  OBSERVATION,
  REVISION,
  createFakeHost,
  makeReceipt,
  makeSelection,
  type FakeHost,
} from "./testHost";

let host: FakeHost;
let uninstall: () => void;
/** What the dev preview mounts while the Site Builder is switched on. */
function Builder() {
  const props = {
    panelId: "preview-1",
    ...context.current,
    url: "http://localhost:5173/pricing",
    isWebviewReady: true,
    onClose: () => {},
  };
  return (
    <>
      <SiteBuilderToolbar {...props} />
      <SiteBuilderDrawer {...props} />
    </>
  );
}

function mount() {
  return render(<Builder />);
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
  vi.restoreAllMocks();
  _resetPluginRuntimeStoreForTest();
  useDevPreviewToolStore.setState({ activeByPanel: {} });
  usePanelStore.setState({ panelsById: {} as never });
  cleanup();
  __resetInspectorControllersForTests();
  __resetComposerMemoryForTests();
  uninstall();
});

describe("preview binding", () => {
  it("binds its own preview in Select mode with the guest runtime body", async () => {
    mount();
    await waitFor(() => expect(host.sitePreview.bind).toHaveBeenCalledTimes(1));
    const body = await loadGuestRuntimeBody();
    // The prelude-wrapped body, not the standalone script: it speaks through `api`.
    expect(body).toContain("api.post(event)");
    expect(host.sitePreview.bind.mock.calls[0]![0]).toEqual({
      panelId: "preview-1",
      runtimeSource: body,
      mode: "select",
    });
    await screen.findByRole("button", { name: "Browse" });
  });

  it("switches the preview between Browse and Select", async () => {
    await mountBound();
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await waitFor(() =>
      expect(host.sitePreview.setMode).toHaveBeenCalledWith({
        sessionId: "session-1",
        mode: "browse",
      })
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Browse" }).getAttribute("aria-pressed")).toBe(
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

  it("opens the app the preview's dev server runs in without asking", async () => {
    host.handlers.set(CHANNELS.workspaceOpen, (args) =>
      args.appRoot
        ? {
            status: "ready",
            workspaceSessionId: "ws-1",
            appRoot: args.appRoot,
            support: { level: "full" },
          }
        : { status: "ambiguous", appRoots: ["/repo", "/repo/apps/docs"] }
    );
    usePanelStore.setState({
      panelsById: {
        "preview-1": {
          id: "preview-1",
          kind: "dev-preview",
          location: "grid",
          cwd: "/repo/apps/docs",
        },
      } as never,
    });
    await mountBound();
    await waitFor(() =>
      expect(host.calls(CHANNELS.workspaceOpen).at(-1)).toMatchObject({
        appRoot: "/repo/apps/docs",
      })
    );
    expect(
      screen.queryByRole("heading", { name: "Which app is this preview showing?" })
    ).toBeNull();
  });

  it("won't trace a preview whose dev server runs from another worktree", async () => {
    usePanelStore.setState({
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", cwd: "/elsewhere" },
      } as never,
    });
    await mountBound();
    await screen.findByText(/runs from another worktree/);
    expect(host.calls(CHANNELS.workspaceOpen)).toHaveLength(0);
  });

  it("traces and offers the agent on a preview-only app, without direct edits", async () => {
    host.handlers.set(CHANNELS.workspaceOpen, () => ({
      status: "ready",
      workspaceSessionId: "ws-1",
      appRoot: "/repo",
      support: { level: "preview-only", reasons: ["Found svelte 4.2.1; editing needs Svelte 5"] },
    }));
    await mountBound();
    // The rule: the reason main gave is shown, under a heading that scopes it to
    // direct editing rather than to the panel as a whole. Matched as a substring
    // because the notice adds what still works alongside it.
    // The rule: the project's capabilities are reported under one "Site source"
    // heading, with the reason main gave scoped to the capability it affects.
    await screen.findByRole("region", { name: "Site source" });
    await screen.findByText(/Found svelte 4\.2\.1; editing needs Svelte 5/);
    expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0);
    // Still traced and still sendable to an agent; only direct edits are gated.
    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: makeSelection({
        documentEpoch: args.documentEpoch as number,
        capabilities: [
          { surface: "text", support: "inspect-only", reason: "unsupported-framework-version" },
          { surface: "classes", support: "inspect-only", reason: "unsupported-framework-version" },
        ],
      }),
    }));
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Selected element" }).textContent).toContain(
      `${FILE}:6`
    );
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
    // Named twice on purpose: in the strip over the page and in the details.
    const identity = screen.getByRole("region", { name: "Selected element" });
    expect(identity.textContent).toContain(`${FILE}:6`);
    expect(screen.getByRole("toolbar", { name: "Site Builder" }).textContent).toContain(
      `${FILE}:6`
    );
    // The trail names the components this element was reached through, and
    // nothing else: generated framework frames are not the user's code, and
    // `each` is control flow — not a file, not a thing an agent can be pointed
    // at, so never a step. Asserted as that rule rather than as a fixed list,
    // so the trail can be restyled without rewriting this.
    const trail = screen.getAllByRole("navigation", { name: "Breadcrumb" })[0]!;
    const crumbs = Array.from(trail.querySelectorAll("li")).map((li) =>
      (li.textContent ?? "").trim()
    );
    expect(crumbs).toContain("PricingCard");
    expect(crumbs.some((crumb) => crumb.includes("each"))).toBe(false);
    expect(crumbs.some((crumb) => crumb.includes("root"))).toBe(false);
    // It ends at what was picked, and marks it as current.
    expect(trail.querySelector('[aria-current="true"]')?.textContent).toContain("Start Pro");
  });

  it("names a picked component by the file main read from source, never a guess", async () => {
    const site = { file: "src/lib/PricingCard.svelte", line: 3, column: 0 };
    let answer: (definedIn: string | null) => void = () => {};
    host.handlers.set(
      CHANNELS.componentDefinitions,
      (args) =>
        new Promise((resolve) => {
          answer = (definedIn) =>
            resolve({
              definitions: (args.callSites as (typeof site)[]).map((callSite) => ({
                ...callSite,
                name: "PricingCard",
                definedIn,
                revision: REVISION,
                definedInRevision: definedIn ? REVISION : null,
              })),
            });
        })
    );
    await mountBound();
    await act(async () =>
      host.pushPreview({
        kind: "guest-event",
        sessionId: "session-1",
        panelId: "preview-1",
        projectId: "p1",
        documentEpoch: 0,
        sequence: 1,
        event: {
          type: "selectionChanged",
          nodes: [OBSERVATION],
          scope: "component",
          component: { ...site, name: "PricingCard" },
        },
      })
    );
    const identity = await screen.findByRole("region", { name: "Selected element" });
    await waitFor(() => expect(host.calls(CHANNELS.componentDefinitions)).toHaveLength(1));
    expect(host.calls(CHANNELS.componentDefinitions)[0]).toMatchObject({
      workspaceSessionId: "ws-1",
      callSites: [site],
    });
    // Until main answers, the component is named but no file is claimed for it —
    // not even the file of the element it was reached through.
    expect(identity.textContent).toContain("PricingCard");
    expect(identity.textContent).not.toContain("src/lib/Card.svelte");
    expect(identity.textContent).not.toContain(`${FILE}:6`);
    const strip = screen.getByRole("toolbar", { name: "Site Builder" });
    expect(strip.textContent).not.toContain(`${FILE}:6`);

    await act(async () => answer("src/lib/Card.svelte"));
    await waitFor(() => expect(identity.textContent).toContain("src/lib/Card.svelte"));
    expect(strip.textContent).toContain("src/lib/Card.svelte");
  });

  it("settles a draft pinned before its component was resolved, after the selection moved on", async () => {
    const site = { file: "src/lib/PricingCard.svelte", line: 3, column: 0 };
    const answers: Array<(definedIn: string | null) => void> = [];
    let closed = false;
    host.handlers.set(CHANNELS.componentDefinitions, (args) => {
      if (closed && args.workspaceSessionId === "ws-1") {
        throw new Error("WORKSPACE_CLOSED: that source workspace is not open; open it again");
      }
      return new Promise((resolve) => {
        answers.push((definedIn) =>
          resolve({
            definitions: (args.callSites as (typeof site)[]).map((callSite) => ({
              ...callSite,
              name: "PricingCard",
              definedIn,
              revision: REVISION,
              definedInRevision: definedIn ? REVISION : null,
            })),
          })
        );
      });
    });
    await mountBound();
    await act(async () =>
      host.pushPreview({
        kind: "guest-event",
        sessionId: "session-1",
        panelId: "preview-1",
        projectId: "p1",
        documentEpoch: 0,
        sequence: 1,
        event: {
          type: "selectionChanged",
          nodes: [OBSERVATION],
          scope: "component",
          component: { ...site, name: "PricingCard" },
        },
      })
    );
    const request = await screen.findByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Make the card pop" } });
    const sendButton = () =>
      screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
    expect(sendButton().disabled).toBe(true);

    // The workspace closes and reopens under a new session, then a plain click
    // elsewhere: the first lookup's answer is for a selection no longer on
    // screen, so the pinned draft must ask for itself — through the new session.
    host.handlers.set(CHANNELS.workspaceOpen, () => ({
      status: "ready",
      workspaceSessionId: "ws-2",
      appRoot: "/repo",
      support: { level: "full" },
    }));
    closed = true;
    host.handlers.set(CHANNELS.selectionResolve, () => {
      throw new Error("WORKSPACE_CLOSED: that source workspace is not open; open it again");
    });
    await act(async () => host.select(0));
    await waitFor(() => expect(host.calls(CHANNELS.workspaceOpen)).toHaveLength(2));
    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: {
        ...makeSelection({ documentEpoch: args.documentEpoch as number, selectionId: "sel-2" }),
        workspaceSessionId: args.workspaceSessionId as string,
      },
    }));
    await act(async () => host.select(0));
    await waitFor(() => expect(answers.length).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(host.calls(CHANNELS.componentDefinitions).at(-1)?.workspaceSessionId).toBe("ws-2")
    );
    await act(async () => {
      for (const answer of answers) answer("src/lib/Card.svelte");
    });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(
      screen.getByRole("button", { name: "PricingCard", pressed: true }).getAttribute("title")
    ).toBe("src/lib/Card.svelte");
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
    const warning = screen.getByText(/all 3 copies/);
    const firstControl = screen.getByRole("button", { name: /^Edit text: / });
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
    expect(screen.queryByRole("button", { name: /^Edit text: / })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Add a class" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove px-6" })).toBeNull();
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
          range: BUTTON_RANGE,
          add: ["shadow-md"],
          remove: [],
          responsive: { kind: "base" },
        },
      ],
    });

    await screen.findByRole("region", { name: "Last change" });
    expect(text()).toMatch(/styles (not verified|unverified)/i);
    expect(text()).not.toMatch(/styles (generated|applied|rendered)/i);
    // The write spent the selection's ranges — so editing resumes only once
    // the page has been asked for the element again and main has re-proved it.
    await waitFor(() => expect(host.sitePreview.reselect).toHaveBeenCalled());
    await waitFor(() => expect(removeButton().disabled).toBe(false));

    await act(async () => host.documentReady(1));
    // A later document is the only thing that proves the reload, and the
    // receipt starts reporting it once one lands — while still refusing to
    // claim anything about the styles, which nothing here can prove.
    await waitFor(() => expect(text()).toMatch(/preview reloaded/i));
    expect(text()).not.toMatch(/preview not yet refreshed/i);
    expect(text()).toMatch(/styles (not verified|unverified)/i);
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
    await screen.findByText("Not in the suggestion list — it'll be written as typed");
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
    expect(removeButton().disabled).toBe(true);
    fireEvent.click(removeButton());
    expect(host.calls(CHANNELS.editApply)).toHaveLength(1);

    await act(async () => finish({ status: "applied", receipt: makeReceipt() }));
    await screen.findByRole("region", { name: "Last change" });
    expect(screen.getByText("Saved — select again to keep editing")).toBeTruthy();
    expect(removeButton().disabled).toBe(true);
    expect(host.calls(CHANNELS.editApply)).toHaveLength(1);
  });

  it("leaves class validity to main, so valid variants aren't refused here", async () => {
    await mountSelected();
    const input = screen.getByRole("combobox", { name: "Add a class" });
    fireEvent.change(input, { target: { value: "[&>*]:p-2 before:content-['x']" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));
    expect(host.calls(CHANNELS.editApply)[0]!.operations).toMatchObject([
      { add: ["[&>*]:p-2", "before:content-['x']"], range: BUTTON_RANGE },
    ]);
  });

  it("keeps a non-breaking space inside one token, as main does", async () => {
    await mountSelected();
    const input = screen.getByRole("combobox", { name: "Add a class" });
    fireEvent.change(input, { target: { value: "after:content-['a\u00a0b']" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));
    expect(host.calls(CHANNELS.editApply)[0]!.operations).toMatchObject([
      { add: ["after:content-['a\u00a0b']"] },
    ]);
  });

  it("writes text verbatim, whitespace included", async () => {
    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: makeSelection({
        documentEpoch: args.documentEpoch as number,
        surfaces: { classes: { tokens: ["px-6"] }, text: { text: " Start Pro " } },
      }),
    }));
    await mountSelected();
    fireEvent.click(screen.getByRole("button", { name: /^Edit text: / }));
    const field = screen.getByRole("textbox", { name: "Text" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(host.calls(CHANNELS.editApply)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /^Edit text: / }));
    fireEvent.change(screen.getByRole("textbox", { name: "Text" }), {
      target: { value: " Go Pro " },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Text" }), { key: "Enter" });
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));
    expect(host.calls(CHANNELS.editApply)[0]!.operations).toMatchObject([{ text: " Go Pro " }]);
  });

  it("invalidates a resolve that is out when our own write to that file lands", async () => {
    await mountSelected();
    let finishWrite: (value: unknown) => void = () => {};
    host.handlers.set(CHANNELS.editApply, () => new Promise((resolve) => (finishWrite = resolve)));
    fireEvent.click(removeButton());
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));

    let finishResolve: (value: unknown) => void = () => {};
    host.handlers.set(
      CHANNELS.selectionResolve,
      () => new Promise((resolve) => (finishResolve = resolve))
    );
    await act(async () => host.select(0));
    await waitFor(() => expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(2));
    await act(async () => finishWrite({ status: "applied", receipt: makeReceipt() }));
    // Long after the settle window: elapsed time alone must not rescue it.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await act(async () =>
      finishResolve({
        status: "ok",
        selection: makeSelection({ documentEpoch: 0, selectionId: "sel-2" }),
      })
    );
    await screen.findByText("Selection changed — select again");
    expect(screen.queryByRole("button", { name: "Remove px-6" })).toBeNull();
  });

  it("removes a class through a token operation", async () => {
    await mountSelected();
    fireEvent.click(removeButton());
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));
    expect(host.calls(CHANNELS.editApply)[0]!.operations).toEqual([
      {
        kind: "set_class_tokens",
        range: BUTTON_RANGE,
        add: [],
        remove: ["px-6"],
        responsive: { kind: "base" },
      },
    ]);
  });

  it("edits literal text on Enter and cancels on Escape without writing", async () => {
    await mountSelected();
    fireEvent.click(screen.getByRole("button", { name: /^Edit text: / }));
    let field = screen.getByRole("textbox", { name: "Text" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Go Pro" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Text" })).toBeNull();
    expect(host.calls(CHANNELS.editApply)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /^Edit text: / }));
    field = screen.getByRole("textbox", { name: "Text" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Go Pro" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));
    expect(host.calls(CHANNELS.editApply)[0]!.operations).toEqual([
      { kind: "set_literal_text", range: BUTTON_RANGE, text: "Go Pro" },
    ]);
    await screen.findByRole("region", { name: "Last change" });
    expect(text()).not.toContain("Styles not verified");
  });

  it("keeps typing inside its field instead of reaching panel shortcuts", async () => {
    await mountBound();
    cleanup();
    const panelKeys = vi.fn();
    render(
      <div onKeyDown={panelKeys}>
        <Builder />
      </div>
    );
    await act(async () => host.select(0));
    const input = await screen.findByRole("combobox", { name: "Add a class" });
    fireEvent.keyDown(input, { key: "s" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(panelKeys).not.toHaveBeenCalled();
  });
});

describe("editing continuity", () => {
  it("keeps editing after a write by having the page re-prove the selection", async () => {
    // The rule: a successful write does not cost the user their selection.
    // The ranges are spent, so the panel asks the page for the element again,
    // main resolves the fresh observation, and editing resumes on PROVEN
    // ranges — never on the old ones.
    await mountSelected();
    fireEvent.click(removeButton());
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));
    await waitFor(() => expect(host.sitePreview.reselect).toHaveBeenCalledTimes(1));
    // A second resolve, from the re-observation.
    await waitFor(() => expect(host.calls(CHANNELS.selectionResolve).length).toBeGreaterThan(1));
    await waitFor(() => expect(removeButton().disabled).toBe(false));
    expect(screen.queryByText(/select again/i)).toBeNull();
  });

  it("keeps the selection through the reload its own write causes", async () => {
    await mountSelected();
    fireEvent.click(removeButton());
    await waitFor(() => expect(removeButton().disabled).toBe(false));
    // HMR lands: a new document. Not a stale banner — a reselect once the
    // runtime is back, and a fresh proof.
    await act(async () => host.epochAdvanced(1));
    await act(async () => host.documentReady(1));
    await waitFor(() => expect(host.sitePreview.reselect).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(removeButton().disabled).toBe(false));
    expect(screen.queryByText(/select again/i)).toBeNull();
  });

  it("refuses a re-proof that names a different element", async () => {
    // An edit that inserted lines above the element can make the old location
    // resolve to a different node in the new source. That is not a
    // continuation: the stale state stands and the user selects again.
    await mountSelected();
    // The next resolve is the re-proof: it names a different element.
    host.handlers.set(CHANNELS.selectionResolve, (args) => {
      const base = makeSelection({ documentEpoch: args.documentEpoch as number });
      const node = base.nodes[0]!;
      return {
        status: "ok",
        selection: {
          ...base,
          nodes: [{ ...node, definition: { ...node.definition!, tagName: "div" }, label: "div" }],
        },
      };
    });
    fireEvent.click(removeButton());
    await waitFor(() => expect(host.sitePreview.reselect).toHaveBeenCalledTimes(1));
    await screen.findByText("Saved — select again to keep editing");
    expect(removeButton().disabled).toBe(true);
  });

  it("falls back to the stale notice when the page no longer has the element", async () => {
    // Nothing is shown as editable that the page did not re-highlight.
    await mountSelected();
    host.reselectFinds = false;
    fireEvent.click(removeButton());
    await waitFor(() => expect(host.sitePreview.reselect).toHaveBeenCalledTimes(1));
    await screen.findByText("Saved — select again to keep editing");
    expect(removeButton().disabled).toBe(true);
  });
});

describe("stale selections", () => {
  it("goes stale when the document epoch advances", async () => {
    await mountSelected();
    await act(async () => host.epochAdvanced(1));
    await screen.findByText("Select again — the page reloaded");
    expect(removeButton().disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: /^Edit text: / }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("combobox", { name: "Add a class" }) as HTMLInputElement).disabled
    ).toBe(true);
  });

  it("won't send a request about a selection the page has moved past, and keeps the draft", async () => {
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    const sendButton = () =>
      screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
    expect(sendButton().disabled).toBe(false);

    await act(async () => host.epochAdvanced(1));
    // The panel says so once, in the identity block, and blocks the send. It
    // used to say it again inside the composer 300px below; the assertion is on
    // the behaviour so removing the repeat is not a test change.
    await screen.findByText("Select again — the page reloaded");
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    expect((request as HTMLTextAreaElement).value).toBe("Say Upgrade");
  });

  it("won't re-send a request that may already be half-way into the agent's input", async () => {
    // The rule: when a delivery failed AFTER typing had started, the panel tells
    // the user to check the terminal first — so Enter must not still be armed.
    // Sending twice is genuinely harmful here, and this is the one failure mode
    // where the remedy and the affordance contradicted each other.
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    const sendButton = () =>
      screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
    expect(sendButton().disabled).toBe(false);

    act(() => {
      updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
        delivery: {
          state: {
            status: "failed",
            message: "The terminal stopped accepting input",
            partial: true,
          },
          title: "claude",
          terminalId: "term-1",
        },
      });
    });

    await waitFor(() => expect(sendButton().disabled).toBe(true));
    // Editing the words is the acknowledgement: the user has been back to the
    // terminal and is deciding again.
    fireEvent.change(request, { target: { value: "Say Upgrade now" } });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  it("keeps the partial-delivery guard when the notice is dismissed", async () => {
    // The guard reads the delivery record, and Dismiss used to clear it — so
    // closing the warning rearmed Enter on the unchanged draft. Hiding the
    // notice and deciding the request is safe to repeat are different acts.
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    const sendButton = () =>
      screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;

    act(() => {
      updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
        delivery: {
          state: {
            status: "failed",
            message: "The terminal stopped accepting input",
            partial: true,
          },
          title: "claude",
          terminalId: "term-1",
        },
      });
    });
    await waitFor(() => expect(sendButton().disabled).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Couldn't send to the agent")).toBeNull();
    expect(sendButton().disabled).toBe(true);
  });

  it("activates the first suggestion when Down reopens a dismissed list", async () => {
    // The rule: Down both opens the list and moves within it, so one press must
    // leave something highlighted. Reading the pre-keystroke `open` made the
    // first Down after an Escape a no-op, and Enter then wrote the raw query
    // instead of the suggestion the user believed was selected.
    await mountSelected();
    const input = screen.getByRole("combobox", { name: "Add a class" });
    fireEvent.change(input, { target: { value: "shadow" } });
    await screen.findByRole("listbox", { name: "Class suggestions" });

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("listbox", { name: "Class suggestions" })).toBeNull()
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox", { name: "Class suggestions" });
    const options = within(listbox).getAllByRole("option");
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
  });

  it("sends an empty-buffer Backspace to the previous class token", async () => {
    // The rule: the step reaches the CHIPS, which are a sibling of the input.
    // A search root that contained only the input found nothing at all.
    await mountSelected();
    const input = screen.getByRole("combobox", { name: "Add a class" });
    fireEvent.keyDown(input, { key: "Backspace" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove rounded-lg" }))
    );
  });

  it("names the selection as current in the trail, never an ancestor", async () => {
    // The drawer hides the terminal crumb because its header already names the
    // element. Marking whatever crumb is left as `aria-current` told screen
    // readers the parent component was the selection.
    await mountSelected();
    for (const trail of screen.getAllByRole("navigation", { name: "Breadcrumb" })) {
      const current = trail.querySelector('[aria-current="true"]');
      expect(current).not.toBeNull();
      expect(current!.textContent).toContain("Start Pro");
      expect(current!.textContent).not.toBe("PricingCard");
    }
  });

  it("still allows an immediate retry when nothing was typed into the agent", async () => {
    // The counterpart: a failure BEFORE any bytes went out leaves nothing to
    // check, so blocking the send would be friction with no payoff.
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    act(() => {
      updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
        delivery: {
          state: { status: "failed", message: "The terminal was gone" },
          title: "claude",
          terminalId: "term-1",
        },
      });
    });
    const sendButton = () =>
      screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
    await screen.findByText("Couldn't send to the agent");
    expect(sendButton().disabled).toBe(false);
  });

  it("holds a request to the bytes of every file it cites, not only the element's", async () => {
    // Innermost first, as the page reports it: PricingCard's call site, then generated code.
    host.handlers.set(CHANNELS.selectionResolve, (args) => {
      const base = makeSelection({ documentEpoch: args.documentEpoch as number });
      const node = base.nodes[0]!;
      return {
        status: "ok",
        selection: { ...base, nodes: [{ ...node, ancestry: [...node.ancestry].reverse() }] },
      };
    });
    await mountSelected();
    const controller = peekBuilderController("preview-1")!;
    let state = controller.getSnapshot().selection;
    await waitFor(() => {
      state = controller.getSnapshot().selection;
      expect(state.status === "ready" && state.revisions !== null).toBe(true);
    });
    if (state.status !== "ready") throw new Error("not ready");
    // The chain's PricingCard call site is cited alongside the element's file.
    expect(Object.keys(state.revisions!).sort()).toEqual(["src/lib/PricingCard.svelte", FILE]);
    expect(await controller.sourcesUnchanged(state.selection, state.revisions)).toBe(true);

    host.diskRevisions.set("src/lib/PricingCard.svelte", "f".repeat(64));
    expect(await controller.sourcesUnchanged(state.selection, state.revisions)).toBe(false);
    host.diskRevisions.set("src/lib/PricingCard.svelte", null);
    expect(await controller.sourcesUnchanged(state.selection, state.revisions)).toBe(false);
  });

  it("keeps the revision a mapping was read from, even if the file changed before it was recorded", async () => {
    host.handlers.set(CHANNELS.selectionResolve, (args) => {
      const base = makeSelection({ documentEpoch: args.documentEpoch as number });
      const node = base.nodes[0]!;
      return {
        status: "ok",
        selection: { ...base, nodes: [{ ...node, ancestry: [...node.ancestry].reverse() }] },
      };
    });
    // Main parsed PricingCard's call site at one revision; disk already holds another.
    host.diskRevisions.set("src/lib/PricingCard.svelte", "e".repeat(64));
    await mountSelected();
    const controller = peekBuilderController("preview-1")!;
    let state = controller.getSnapshot().selection;
    await waitFor(() => {
      state = controller.getSnapshot().selection;
      expect(state.status === "ready" && state.revisions !== null).toBe(true);
    });
    if (state.status !== "ready") throw new Error("not ready");
    expect(await controller.sourcesUnchanged(state.selection, state.revisions)).toBe(false);
  });

  it("won't let an element's revision paper over a mapping read from other bytes of its file", async () => {
    host.handlers.set(CHANNELS.selectionResolve, (args) => {
      const base = makeSelection({ documentEpoch: args.documentEpoch as number });
      const node = base.nodes[0]!;
      return {
        status: "ok",
        selection: {
          ...base,
          nodes: [
            {
              ...node,
              ancestry: [
                {
                  kind: "component",
                  location: { file: FILE, line: 2, column: 0 },
                  componentTag: "Badge",
                  generated: false,
                },
              ],
            },
          ],
        },
      };
    });
    host.handlers.set(CHANNELS.componentDefinitions, (args) => ({
      definitions: (args.callSites as Array<{ file: string; line: number; column: number }>).map(
        (site) => ({
          ...site,
          name: "Badge",
          definedIn: null,
          revision: "a".repeat(64),
          definedInRevision: null,
        })
      ),
    }));
    await mountSelected();
    const controller = peekBuilderController("preview-1")!;
    await waitFor(() => {
      const state = controller.getSnapshot().selection;
      expect(state.status === "ready" && state.revisions !== null).toBe(true);
    });
    const state = controller.getSnapshot().selection;
    if (state.status !== "ready") throw new Error("not ready");
    expect(state.revisions![FILE]).toBeNull();
  });

  it("refuses to send source text read from other bytes than the selection", async () => {
    host.handlers.set(CHANNELS.sourceExcerpt, () => ({
      status: "ok",
      text: "<button>Changed</button>",
      firstLine: 6,
      revision: "b".repeat(64),
    }));
    // The request belongs to a live preview with the builder on.
    usePanelStore.setState({
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", worktreeId: "wt-1" },
      } as never,
    });
    useDevPreviewToolStore.setState({
      activeByPanel: { "preview-1": "daintree.sveltekit-builder.builder" },
    });
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    const sendButton = screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false));
    fireEvent.click(sendButton);
    await screen.findByText(/The source changed since you picked this/);
    expect((request as HTMLTextAreaElement).value).toBe("Say Upgrade");
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
    await screen.findByText("Select again — the file changed");
    expect(removeButton().disabled).toBe(true);
  });

  it("keys on the event's epoch when documentReady beats epoch-advanced", async () => {
    await mountSelected();
    // The reinstalled runtime reports the new document before the bridge's push.
    await act(async () => host.documentReady(1));
    await screen.findByText("Select again — the page reloaded");
    await act(async () => host.select(1));
    await waitFor(() => expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(2));
    expect(host.calls(CHANNELS.selectionResolve)[1]).toMatchObject({ documentEpoch: 1 });
    await waitFor(() => expect(screen.queryByText("Selection changed — select again")).toBeNull());
    await waitFor(() => expect(removeButton().disabled).toBe(false));

    // The late push for the epoch we are already in must not invalidate anything.
    await act(async () => host.epochAdvanced(1));
    expect(screen.queryByText("Selection changed — select again")).toBeNull();
    expect(removeButton().disabled).toBe(false);
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
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await screen.findByText("Select again — the page reloaded");
    expect(removeButton().disabled).toBe(true);
  });

  it("refuses to resolve a click on a file that changed moments ago, until HMR can land", async () => {
    await mountBound();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    await act(async () =>
      host.pushPlugin(PUSH_CHANNELS.sourceChanged, {
        workspaceSessionId: "ws-1",
        file: FILE,
        revision: null,
      })
    );
    clock.mockReturnValue(start + 400);
    await act(async () => host.select(0));
    await screen.findByText("This file just changed — select again");
    expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(0);

    clock.mockReturnValue(start + 1500);
    await act(async () => host.select(0));
    await screen.findByRole("button", { name: "Remove px-6" });
    expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(1);
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
    await screen.findByRole("region", { name: "Last change" });
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
  it("reopens the workspace when main reports it closed", async () => {
    await mountSelected();
    host.handlers.set(CHANNELS.workspaceOpen, () => ({
      status: "ready",
      workspaceSessionId: "ws-2",
      appRoot: "/repo",
      support: { level: "full" },
    }));
    host.handlers.set(CHANNELS.selectionResolve, () => {
      throw new Error("WORKSPACE_CLOSED: that source workspace is not open; open it again");
    });
    await act(async () => host.select(0));
    await waitFor(() => expect(host.calls(CHANNELS.workspaceOpen)).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Remove px-6" })).toBeNull();

    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: {
        ...makeSelection({ documentEpoch: 0 }),
        workspaceSessionId: args.workspaceSessionId as string,
      },
    }));
    await act(async () => host.select(0));
    await screen.findByRole("button", { name: "Remove px-6" });
    expect(host.calls(CHANNELS.selectionResolve).at(-1)).toMatchObject({
      workspaceSessionId: "ws-2",
    });
  });

  it("tears down on plugin disable and starts fresh when re-enabled", async () => {
    // What the host does: the slot resolves to nothing while the plugin is disabled.
    function Gated() {
      const disabled = usePluginRuntimeStore((state) => state.disabledPluginIds.has(PLUGIN_ID));
      return disabled ? null : <Builder />;
    }
    render(<Gated />);
    await waitFor(() => expect(host.sitePreview.bind).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(host.calls(CHANNELS.workspaceOpen)).toHaveLength(1));

    await act(async () =>
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set([PLUGIN_ID]) })
    );
    expect(host.sitePreview.detach).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(host.listenerCounts()).toEqual({ preview: 0, plugin: 0 });
    await act(async () => {});
    expect(host.sitePreview.bind).toHaveBeenCalledTimes(1);
    expect(host.calls(CHANNELS.workspaceOpen)).toHaveLength(1);

    host.handlers.set(CHANNELS.workspaceOpen, () => ({
      status: "ready",
      workspaceSessionId: "ws-2",
      appRoot: "/repo",
      support: { level: "full" },
    }));
    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: {
        ...makeSelection({ documentEpoch: 0 }),
        workspaceSessionId: args.workspaceSessionId as string,
      },
    }));
    await act(async () => usePluginRuntimeStore.setState({ disabledPluginIds: new Set() }));
    await waitFor(() => expect(host.sitePreview.bind).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(host.calls(CHANNELS.workspaceOpen)).toHaveLength(2));
    await screen.findByRole("button", { name: "Browse" });
    await act(async () => host.documentReady(0));
    await act(async () => host.select(0));
    await screen.findByRole("button", { name: "Remove px-6" });
    expect(host.calls(CHANNELS.selectionResolve).at(-1)).toMatchObject({
      workspaceSessionId: "ws-2",
    });
  });

  it("discards an edit reply that lands after the panel moved to another worktree", async () => {
    await mountSelected();
    let finish: (value: unknown) => void = () => {};
    host.handlers.set(CHANNELS.editApply, () => new Promise((resolve) => (finish = resolve)));
    fireEvent.click(removeButton());
    await waitFor(() => expect(host.calls(CHANNELS.editApply)).toHaveLength(1));

    cleanup();
    host.handlers.set(CHANNELS.workspaceOpen, () => ({
      status: "ready",
      workspaceSessionId: "ws-2",
      appRoot: "/repo-2",
      support: { level: "full" },
    }));
    context.current = { projectId: "p1", worktreeId: "wt-2", worktreePath: "/repo-2" };
    mount();
    await waitFor(() => expect(host.calls(CHANNELS.workspaceOpen)).toHaveLength(2));
    await waitFor(() => expect(host.sitePreview.bind).toHaveBeenCalledTimes(2));

    await act(async () => finish({ status: "applied", receipt: makeReceipt() }));
    await act(async () => {});
    expect(text()).not.toMatch(/Saved —/);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("keeps the binding across a remount", async () => {
    await mountSelected();
    cleanup();
    expect(host.sitePreview.detach).not.toHaveBeenCalled();
    mount();
    expect(screen.getByRole("button", { name: "Remove px-6" })).toBeTruthy();
    expect(host.sitePreview.bind).toHaveBeenCalledTimes(1);
  });

  it("releases the preview and workspace once the builder is switched off", async () => {
    await mountSelected();
    cleanup();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(host.sitePreview.detach).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(host.calls(CHANNELS.workspaceClose)).toEqual([{ workspaceSessionId: "ws-1" }]);
  });

  it("disconnects the preview when the panel moves to another worktree", async () => {
    await mountSelected();
    cleanup();
    context.current = { projectId: "p1", worktreeId: "wt-2", worktreePath: "/repo-2" };
    mount();
    await waitFor(() =>
      expect(host.sitePreview.detach).toHaveBeenCalledWith({ sessionId: "session-1" })
    );
    await waitFor(() =>
      expect(host.calls(CHANNELS.workspaceOpen).at(-1)).toMatchObject({ worktreeId: "wt-2" })
    );
    expect(screen.queryByRole("button", { name: "Remove px-6" })).toBeNull();
  });
});

describe("preview reattach", () => {
  it("reattaches on its own when the grid recreates the preview's page", async () => {
    await mountBound();
    expect(host.sitePreview.bind).toHaveBeenCalledTimes(1);

    await act(async () =>
      host.pushPreview({
        kind: "detached",
        sessionId: "session-1",
        projectId: "p1",
        reason: "debugger-detached",
      })
    );

    await waitFor(() => expect(host.sitePreview.bind).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await screen.findByRole("button", { name: "Browse" });
  });

  it("stays disconnected when the user asked to disconnect", async () => {
    await mountBound();

    await act(async () =>
      host.pushPreview({
        kind: "detached",
        sessionId: "session-1",
        projectId: "p1",
        reason: "requested",
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(host.sitePreview.bind).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});

describe("builder lifetime", () => {
  it("recovers when its controller is released while the builder is still on screen", async () => {
    // A controller can be disposed under a mounted builder — an idle check that
    // ran before a slow commit claimed it. Rendering the dead one leaves the
    // strip on "Connecting" forever.
    await mountBound();
    expect(host.sitePreview.bind).toHaveBeenCalledTimes(1);

    await act(async () => releaseBuilderController("preview-1"));

    await waitFor(() => expect(host.sitePreview.bind).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Browse" });
  });
});

describe("builder lifetime while switched on", () => {
  function builderOn() {
    usePanelStore.setState({
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid" },
      } as never,
    });
    useDevPreviewToolStore.setState({
      activeByPanel: { "preview-1": "daintree.sveltekit-builder.builder" },
    });
  }

  afterEach(() => {
    useDevPreviewToolStore.setState({ activeByPanel: {} });
    usePanelStore.setState({ panelsById: {} as never });
  });

  it("keeps the binding and Undo while the preview is hidden, and lets go when switched off", async () => {
    builderOn();
    await mountSelected();
    fireEvent.click(removeButton());
    await screen.findByRole("button", { name: "Undo" });

    cleanup();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(host.sitePreview.detach).not.toHaveBeenCalled();

    mount();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(host.sitePreview.bind).toHaveBeenCalledTimes(1);

    cleanup();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await act(async () => useDevPreviewToolStore.getState().setActive("preview-1", null));
    expect(host.sitePreview.detach).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(host.calls(CHANNELS.workspaceClose)).toEqual([{ workspaceSessionId: "ws-1" }]);
  });

  it("keeps trying to connect while the preview has no page yet", async () => {
    let attempts = 0;
    host.sitePreview.bind.mockImplementation(async (request) => {
      attempts++;
      if (attempts < 3) throw new Error("No dev preview is available on that panel");
      return {
        sessionId: "session-1",
        panelId: request.panelId,
        projectId: "p1",
        documentEpoch: 0,
        mode: request.mode ?? "select",
        guestReady: false,
        droppedMessages: 0,
      };
    });
    mount();
    await screen.findByText("Waiting for the page to load");
    await waitFor(() => expect(attempts).toBe(3), { timeout: 3000 });
    await waitFor(() => expect(screen.queryByText("Waiting for the page to load")).toBeNull());
  });
});
