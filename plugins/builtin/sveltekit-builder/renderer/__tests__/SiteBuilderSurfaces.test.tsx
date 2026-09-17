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
import { BUILDER_TOOL_ID, CHANNELS, PLUGIN_ID, PUSH_CHANNELS } from "../../shared/protocol";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import {
  __resetComposerMemoryForTests,
  composerMemoryKey,
  updateComposerMemory,
} from "../composerMemory";
import { usePanelStore } from "@/store/panelStore";
import {
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
  // The selection has landed when the drawer names where it came from and the
  // composer is there to send a request about it. This used to wait on a class
  // chip's remove control — the only readiness signal the panel had while it
  // was an editor — so every test in this file, editing or not, was gated on a
  // control that has nothing to do with what it was asserting.
  await screen.findByRole("textbox", { name: "Request for the agent" });
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Selected element" }).textContent).toContain(
      `${FILE}:6`
    )
  );
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

describe("page verdicts", () => {
  function runtimeIssue(code: "not-dev-build" | "overlay-blocked") {
    host.pushPreview({
      kind: "guest-event",
      sessionId: "session-1",
      panelId: "preview-1",
      projectId: "p1",
      documentEpoch: 0,
      sequence: 2,
      event: { type: "runtimeIssue", code, detail: "" },
    });
  }

  it("drops a production-build verdict that a traced selection disproves", async () => {
    await mountBound();
    await act(async () => runtimeIssue("not-dev-build"));
    expect(text()).toContain("production build");

    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(text()).not.toContain("production build");
  });

  it("keeps a verdict that a traced element says nothing about", async () => {
    await mountBound();
    await act(async () => runtimeIssue("overlay-blocked"));
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(text()).toContain("The page blocked the selection overlay");
  });
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

  it("keeps a way to switch apps after one was opened, and drops what belonged to the old one", async () => {
    host.handlers.set(CHANNELS.workspaceOpen, (args) =>
      args.appRoot
        ? {
            status: "ready",
            workspaceSessionId: `ws-${String(args.appRoot).split("/").pop()}`,
            appRoot: args.appRoot,
            support: { level: "full" },
          }
        : { status: "ambiguous", appRoots: ["/repo/apps/web", "/repo/apps/docs"] }
    );
    usePanelStore.setState({
      panelsById: {
        "preview-1": {
          id: "preview-1",
          kind: "dev-preview",
          location: "grid",
          cwd: "/repo/apps/web",
        },
      } as never,
    });
    await mountBound();
    // The drawer opens for a selection; the app it came from is named above it.
    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: {
        ...makeSelection({ documentEpoch: args.documentEpoch as number }),
        workspaceSessionId: "ws-web",
        appRoot: "/repo/apps/web",
      },
    }));
    await act(async () => host.select(0));
    await screen.findByRole("combobox", { name: "Site source app" });
    const controller = peekBuilderController("preview-1")!;
    await act(async () => controller.switchApp("/repo/apps/docs"));
    await waitFor(() =>
      expect(host.calls(CHANNELS.workspaceOpen).at(-1)).toMatchObject({
        appRoot: "/repo/apps/docs",
      })
    );
    expect(host.calls(CHANNELS.workspaceClose)).toContainEqual({ workspaceSessionId: "ws-web" });
    await waitFor(() => {
      const workspace = controller.getSnapshot().workspace;
      expect(workspace.status === "ready" && workspace.appRoot).toBe("/repo/apps/docs");
    });
    // The selection was proven against the other app's source.
    expect(controller.getSnapshot().selection.status).toBe("none");
    // …and with nothing selected, the switcher is still there to switch back.
    await screen.findByRole("combobox", { name: "Site source app" });
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
    // The rule: a Svelte version this plugin cannot write to costs the user
    // nothing, so the panel says nothing about it. What the builder offers —
    // trace an element, hand it to an agent — does not depend on being able to
    // edit the source here, and a notice about a road that isn't there would
    // read as a degraded panel.
    expect(screen.queryByRole("region", { name: "Site source" })).toBeNull();
    expect(screen.queryByText(/editing needs Svelte 5/)).toBeNull();
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
    // Named once: the drawer's identity block carries the source, and the strip
    // repeats it only while the drawer is not there to show it.
    const identity = screen.getByRole("region", { name: "Selected element" });
    expect(identity.textContent).toContain(`${FILE}:6`);
    expect(screen.getByRole("toolbar", { name: "Site Builder" }).textContent).not.toContain(
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
    // The strip defers to the open drawer for the file.
    expect(strip.textContent).not.toContain("src/lib/Card.svelte");
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
});

describe("starting a fresh agent", () => {
  it("offers the agents the host can launch, not a fixed three", async () => {
    const { useCliAvailabilityStore } = await import("@/store/cliAvailabilityStore");
    const previous = useCliAvailabilityStore.getState();
    useCliAvailabilityStore.setState({
      isInitialized: true,
      // Blocked is installed but can't launch; Grok launches but can't be seen
      // waiting at its prompt, so a request can't be typed into it safely.
      availability: {
        claude: "blocked",
        codex: "missing",
        gemini: "missing",
        grok: "ready",
        opencode: "ready",
      },
    } as never);
    try {
      usePanelStore.setState({
        panelsById: {
          "preview-1": {
            id: "preview-1",
            kind: "dev-preview",
            location: "grid",
            worktreeId: "wt-1",
          },
        } as never,
      });
      useDevPreviewToolStore.setState({ activeByPanel: { "preview-1": BUILDER_TOOL_ID } });
      const { actionService } = await import("@/services/ActionService");
      const dispatch = vi
        .spyOn(actionService, "dispatch")
        .mockImplementation((async () => ({ ok: false, error: { message: "stop" } })) as never);
      await mountSelected();
      const request = screen.getByRole("textbox", { name: "Request for the agent" });
      fireEvent.change(request, { target: { value: "Say Upgrade" } });
      const sendButton = screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
      await waitFor(() => expect(sendButton.disabled).toBe(false));
      fireEvent.click(sendButton);
      await waitFor(() =>
        expect(dispatch).toHaveBeenCalledWith(
          "agent.launch",
          expect.objectContaining({ agentId: "opencode" }),
          expect.anything()
        )
      );
    } finally {
      useCliAvailabilityStore.setState(previous);
    }
  });
});

describe("request scope", () => {
  it("lists a deep chain with repeated names instead of squeezing it into segments", async () => {
    const chain = ["Card", "Grid", "Card", "Section", "Layout"].map((name, depth) => ({
      kind: "component" as const,
      location: { file: `src/lib/${name}${depth}.svelte`, line: depth + 2, column: 0 },
      componentTag: name,
      generated: false,
    }));
    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: makeSelection({
        documentEpoch: args.documentEpoch as number,
        node: { ancestry: chain },
      }),
    }));
    await mountBound();
    await act(async () => host.select(0));
    await screen.findByRole("combobox", { name: "What the request is about" });
    expect(screen.queryByRole("button", { name: "Element", pressed: true })).toBeNull();
  });
});

describe("an app inside a monorepo", () => {
  const APP = "/repo/apps/site";

  function openApp() {
    host.handlers.set(CHANNELS.workspaceOpen, () => ({
      status: "ready",
      workspaceSessionId: "ws-1",
      appRoot: APP,
      support: { level: "full" },
    }));
    host.handlers.set(CHANNELS.selectionResolve, (args) => {
      const selection = {
        ...makeSelection({ documentEpoch: args.documentEpoch as number }),
        appRoot: APP,
      };
      selection.nodes[0]!.definition!.revision = host.diskRevision;
      return { status: "ok", selection };
    });
    // Main's receipts name files from the worktree; the page names them from the app.
    host.handlers.set(CHANNELS.editApply, () => {
      const receipt = makeReceipt({ beforeRevision: host.diskRevision, file: `apps/site/${FILE}` });
      host.diskRevision = receipt.afterRevision;
      return { status: "applied", receipt };
    });
  }

  it("opens and copies a picked component's file inside the app, as the agent prompt names it", async () => {
    openApp();
    const site = { file: "src/lib/PricingCard.svelte", line: 3, column: 0 };
    host.handlers.set(CHANNELS.componentDefinitions, (args) => ({
      definitions: (args.callSites as (typeof site)[]).map((callSite) => ({
        ...callSite,
        name: "PricingCard",
        definedIn: "src/lib/Card.svelte",
        revision: REVISION,
        definedInRevision: REVISION,
      })),
    }));
    const { actionService } = await import("@/services/ActionService");
    const dispatch = vi.spyOn(actionService, "dispatch").mockResolvedValue({ ok: true } as never);
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
    await waitFor(() => expect(identity.textContent).toContain("apps/site/src/lib/Card.svelte"));
    fireEvent.click(within(identity).getByRole("button", { name: "Open in editor" }));
    expect(dispatch).toHaveBeenCalledWith(
      "file.openInEditor",
      { path: "/repo/apps/site/src/lib/Card.svelte" },
      { source: "user" }
    );
  });
});

describe("stale selections", () => {
  it("goes stale when the document epoch advances", async () => {
    await mountSelected();
    await act(async () => host.epochAdvanced(1));
    await screen.findByText("Select again — the page reloaded");
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

  it("won't re-send on Enter when delivery couldn't be confirmed, but sends when asked to", async () => {
    // The host lost track of the submission: the request may be in the agent
    // already. The unchanged draft must not go again on a casual Enter — and
    // the notice's own "Send it again" must actually send, not flag a run that
    // has already finished.
    usePanelStore.setState({
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", worktreeId: "wt-1" },
      } as never,
    });
    useDevPreviewToolStore.setState({ activeByPanel: { "preview-1": BUILDER_TOOL_ID } });
    const { actionService } = await import("@/services/ActionService");
    const sent: string[] = [];
    const dispatch = vi.spyOn(actionService, "dispatch").mockImplementation((async (
      id: string,
      args: Record<string, unknown>
    ) => {
      switch (id) {
        case "agent.launch":
          return { ok: true, result: { launched: true, terminalId: "term-9" } };
        case "terminal.getStatus":
          return {
            ok: true,
            result: {
              terminals: [
                {
                  terminalId: "term-9",
                  agentState: "waiting",
                  ...(args.submissionToken ? { submission: { phase: "pty_written" } } : {}),
                },
              ],
            },
          };
        case "terminal.sendCommand":
          sent.push(String(args.command));
          return { ok: true, result: { submissionToken: `token-${sent.length}` } };
        default:
          return { ok: false, error: { message: `unexpected ${id}` } };
      }
    }) as never);
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    const sendButton = () =>
      screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
    await waitFor(() => expect(sendButton().disabled).toBe(false));

    act(() => {
      updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
        delivery: { state: { status: "unconfirmed" }, title: "claude", terminalId: "term-1" },
      });
    });
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    const before = dispatch.mock.calls.length;
    fireEvent.keyDown(request, { key: "Enter" });
    await act(async () => {});
    expect(dispatch.mock.calls.length).toBe(before);
    expect(text()).toContain("Delivery unconfirmed");

    expect(sent).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Send it again" }));
    // A new run, all the way to the terminal: exactly one more submission.
    await waitFor(() => expect(sent).toHaveLength(1), { timeout: 4000 });
    expect(sent[0]).toContain("Say Upgrade");
    await screen.findByText(/^Sent to /);
  });

  it("doesn't offer to send again when there is nothing it could send", async () => {
    await mountSelected();
    act(() => {
      updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
        delivery: { state: { status: "unconfirmed" }, title: "claude", terminalId: "term-1" },
      });
    });
    await screen.findByText("Delivery unconfirmed");
    // No request typed: the button would do nothing, so it isn't there.
    expect(screen.queryByRole("button", { name: "Send it again" })).toBeNull();
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

  it("sends file references and the route around the page, never source text", async () => {
    host.handlers.set(CHANNELS.projectModel, () => ({
      appRoot: "/repo",
      packageManager: "npm",
      versions: { svelte: "5.2.0", kit: "2.15.0", tailwind: "4.1.0", vite: "7.0.0" },
      support: { level: "full" },
      routes: [
        {
          routeId: "/pricing",
          pageFile: FILE,
          layoutFiles: ["src/routes/+layout.svelte"],
          dataFiles: ["src/routes/pricing/+page.server.ts"],
          dynamic: false,
          endpointOnly: false,
        },
      ],
    }));
    usePanelStore.setState({
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", worktreeId: "wt-1" },
      } as never,
    });
    useDevPreviewToolStore.setState({ activeByPanel: { "preview-1": BUILDER_TOOL_ID } });
    const { actionService } = await import("@/services/ActionService");
    const sent: string[] = [];
    vi.spyOn(actionService, "dispatch").mockImplementation((async (
      id: string,
      args: Record<string, unknown>
    ) => {
      if (id === "agent.launch") return { ok: true, result: { launched: true, terminalId: "t" } };
      if (id === "terminal.getStatus") {
        return {
          ok: true,
          result: {
            terminals: [
              {
                terminalId: "t",
                agentState: "waiting",
                ...(args.submissionToken ? { submission: { phase: "pty_written" } } : {}),
              },
            ],
          },
        };
      }
      if (id === "terminal.sendCommand") {
        sent.push(String(args.command));
        return { ok: true, result: { submissionToken: "tok" } };
      }
      return { ok: false, error: { message: `unexpected ${id}` } };
    }) as never);

    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    const sendButton = screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false));
    fireEvent.click(sendButton);
    await waitFor(() => expect(sent).toHaveLength(1), { timeout: 4000 });

    expect(sent[0]).toContain("- Route files, outermost layout first:");
    expect(sent[0]).toContain("  - layout: src/routes/+layout.svelte");
    expect(sent[0]).toContain("  - data: src/routes/pricing/+page.server.ts");
    expect(sent[0]).toContain(`  - page: ${FILE}`);
    expect(sent[0]).toContain("(SvelteKit 2.15.0, Svelte 5.2.0, Tailwind 4.1.0)");
    expect(sent[0]).not.toContain("```");
    expect(host.calls(CHANNELS.sourceExcerpt)).toEqual([]);

    // The notice keeps the exact request, one disclosure away.
    fireEvent.click(await screen.findByRole("button", { name: "View request" }));
    expect(screen.getByRole("group", { name: "Request text" }).textContent).toBe(sent[0]);
    // Beside the status region, not inside it: a status is read out whole.
    expect(
      screen.getByRole("group", { name: "Request text" }).closest('[role="status"]')
    ).toBeNull();
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
    // A change to another file leaves this selection alone.
    expect(screen.queryByText("Select again — the file changed")).toBeNull();
    await act(async () =>
      host.pushPlugin(PUSH_CHANNELS.sourceChanged, {
        workspaceSessionId: "ws-1",
        file: FILE,
        revision: null,
      })
    );
    await screen.findByText("Select again — the file changed");
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
    await waitFor(() => expect(screen.queryByText("Select again — the page reloaded")).toBeNull());

    // The late push for the epoch we are already in must not invalidate anything.
    await act(async () => host.epochAdvanced(1));
    expect(screen.queryByText("Selection changed — select again")).toBeNull();
    expect(screen.queryByText("Select again — the page reloaded")).toBeNull();
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
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();
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
    await screen.findByRole("textbox", { name: "Request for the agent" });
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
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();
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
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();

    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: {
        ...makeSelection({ documentEpoch: 0 }),
        workspaceSessionId: args.workspaceSessionId as string,
      },
    }));
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
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
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(host.calls(CHANNELS.selectionResolve).at(-1)).toMatchObject({
      workspaceSessionId: "ws-2",
    });
  });

  it("keeps the binding across a remount", async () => {
    await mountSelected();
    cleanup();
    expect(host.sitePreview.detach).not.toHaveBeenCalled();
    mount();
    expect(screen.getByRole("region", { name: "Selected element" })).toBeTruthy();
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
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();
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

  it("keeps the binding while the preview is hidden, and lets go when switched off", async () => {
    builderOn();
    await mountSelected();

    cleanup();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(host.sitePreview.detach).not.toHaveBeenCalled();

    mount();
    // Remounted onto the same binding, not a second one.
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

  it("says it couldn't connect, and why, once it has stopped trying", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      host.sitePreview.bind.mockImplementation(async () => {
        throw new Error("The preview's page refused the runtime");
      });
      mount();
      await screen.findByText("Waiting for the page to load");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });
      await screen.findByText(
        "Couldn't connect to the page — The preview's page refused the runtime"
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
