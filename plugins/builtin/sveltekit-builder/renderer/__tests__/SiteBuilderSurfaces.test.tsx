// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  current: { projectId: "p1", worktreeId: "wt-1", worktreePath: "/repo" },
}));

import { SiteBuilderDrawer, SiteBuilderToolbar } from "../SiteBuilderSurfaces";
import { createBuilderSession, type InspectorController } from "../inspectorController";
import {
  __resetDevPreviewToolSessionsForTests,
  peekDevPreviewToolSession,
  publishDevPreviewToolContext,
  startDevPreviewToolSessions,
} from "@/services/devPreviewTools/sessionManager";
import {
  __resetDevPreviewToolsForTests,
  registerDevPreviewTool,
} from "@/registry/devPreviewToolRegistry";
import {
  BUILDER_TOOL_ID,
  CHANNELS,
  GUEST_ADAPTER_ID,
  PLUGIN_ID,
  PUSH_CHANNELS,
} from "../../shared/protocol";
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
  makeSelection,
  type FakeHost,
} from "./testHost";

let host: FakeHost;
let uninstall: () => void;

function hostContext() {
  return {
    panelId: "preview-1",
    ...context.current,
    url: "http://localhost:5173/pricing",
    isWebviewReady: true,
  };
}

/** The builder's session, which the host owns for as long as the tool is on. */
function session(): InspectorController {
  const live = peekDevPreviewToolSession("preview-1");
  if (!live) throw new Error("no builder session for preview-1");
  return live as InspectorController;
}

/**
 * Switch the builder on the way the dev preview does — through the real host
 * session manager, so the surfaces below are fed the session it built.
 */
function switchOn() {
  startDevPreviewToolSessions();
  publishDevPreviewToolContext(hostContext());
  useDevPreviewToolStore.getState().setActive("preview-1", BUILDER_TOOL_ID);
}

/** What the dev preview mounts while the Site Builder is switched on. */
function Builder() {
  const props = { ...hostContext(), session: session(), onClose: () => {} };
  return (
    <>
      <SiteBuilderToolbar {...props} />
      <SiteBuilderDrawer {...props} />
    </>
  );
}

function mount() {
  switchOn();
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
  // The host only keeps a tool switched on for a preview the panel store
  // holds; tests that need more of the panel replace this wholesale.
  usePanelStore.setState({
    panelIds: ["preview-1"],
    panelsById: { "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid" } },
  } as never);
  host = createFakeHost();
  uninstall = host.install();
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([
      [
        PLUGIN_ID,
        {
          devMode: false,
          displayName: "Site Builder",
          previewToolIds: new Set([BUILDER_TOOL_ID]),
        },
      ],
    ]),
    disabledPluginIds: new Set(),
  });
  registerDevPreviewTool({
    id: BUILDER_TOOL_ID,
    pluginId: PLUGIN_ID,
    label: "Site Builder",
    Button: () => null,
    createSession: (toolContext) => createBuilderSession(toolContext),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetPluginRuntimeStoreForTest();
  useDevPreviewToolStore.setState({ activeByPanel: {} });
  // Both halves: a test that seeds terminals sets `panelIds` too, and leaving
  // those ids behind hands the next test a composer with phantom destinations.
  usePanelStore.setState({ panelIds: [], panelsById: {} } as never);
  cleanup();
  __resetDevPreviewToolSessionsForTests();
  __resetDevPreviewToolsForTests();
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

  function metadataProbed(locations: boolean, ancestry: boolean) {
    host.pushPreview({
      kind: "guest-event",
      sessionId: "session-1",
      panelId: "preview-1",
      projectId: "p1",
      documentEpoch: 0,
      sequence: 3,
      event: { type: "metadataProbed", locations, ancestry },
    });
  }

  it("names elements only, and says why, when the page reports no component chain", async () => {
    await mountBound();
    await act(async () => metadataProbed(true, false));
    expect(text()).toContain("not the components above them");

    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    // The selection still traces; only the component pick is withheld, so
    // every crumb in the trail stays text.
    expect(text()).toContain("not the components above them");
    for (const trail of screen.getAllByRole("navigation", { name: "Breadcrumb" })) {
      expect(within(trail).queryAllByRole("button")).toHaveLength(0);
    }
  });

  it("offers the component pick again once a selection carries a chain after all", async () => {
    await mountBound();
    await act(async () => metadataProbed(true, false));
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(text()).toContain("not the components above them");

    await act(async () =>
      host.select(0, [
        {
          ...OBSERVATION,
          ancestry: [
            {
              type: "component",
              file: "src/routes/+page.svelte",
              line: 8,
              column: 4,
              componentTag: "PricingCard",
            },
          ],
        },
      ])
    );
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(text()).not.toContain("not the components above them");
    // And the crumbs are controls again, not text.
    await waitFor(() => {
      const trails = screen.getAllByRole("navigation", { name: "Breadcrumb" });
      expect(trails.some((trail) => within(trail).queryAllByRole("button").length > 0)).toBe(true);
    });
  });

  it("recovers the component pick even after the notice about it was dismissed", async () => {
    await mountBound();
    await act(async () => metadataProbed(true, false));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(text()).not.toContain("not the components above them");

    await act(async () =>
      host.select(0, [
        {
          ...OBSERVATION,
          ancestry: [
            {
              type: "component",
              file: "src/routes/+page.svelte",
              line: 8,
              column: 4,
              componentTag: "PricingCard",
            },
          ],
        },
      ])
    );
    await screen.findByRole("textbox", { name: "Request for the agent" });
    await waitFor(() => {
      const trails = screen.getAllByRole("navigation", { name: "Breadcrumb" });
      expect(trails.some((trail) => within(trail).queryAllByRole("button").length > 0)).toBe(true);
    });
  });

  it("keeps what the page's metadata supports through a same-document readiness update", async () => {
    await mountBound();
    await act(async () => metadataProbed(true, false));
    // A client-side navigation reports the page again without a new document.
    await act(async () => host.documentReady(0));
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    for (const trail of screen.getAllByRole("navigation", { name: "Breadcrumb" })) {
      expect(within(trail).queryAllByRole("button")).toHaveLength(0);
    }
  });

  it("drops a production-build verdict when a late probe finds readable metadata", async () => {
    await mountBound();
    await act(async () => runtimeIssue("not-dev-build"));
    expect(text()).toContain("production build");
    // The page hydrated after the audit's deadline; nothing was clicked.
    await act(async () => metadataProbed(true, true));
    expect(text()).not.toContain("production build");
  });

  it("warns up front when the page's metadata cannot be read at all", async () => {
    await mountBound();
    await act(async () => metadataProbed(false, false));
    expect(text()).toContain("shape the builder doesn't recognise");
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
  it("binds its own preview in Select mode, naming the host's guest adapter", async () => {
    mount();
    await waitFor(() => expect(host.sitePreview.bind).toHaveBeenCalledTimes(1));
    // An id, never a body: the host owns the runtime it installs.
    expect(host.sitePreview.bind.mock.calls[0]![0]).toEqual({
      panelId: "preview-1",
      adapterId: GUEST_ADAPTER_ID,
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

  it("opens the workspace for its own preview and listens to that preview's pushes only", async () => {
    await mountBound();
    await waitFor(() =>
      expect(host.calls(CHANNELS.workspaceOpen).at(-1)).toMatchObject({
        previewPanelId: "preview-1",
      })
    );
    const subscribed = host.onPanel.mock.calls.map(([, channel, panelId]) => [channel, panelId]);
    expect(subscribed).toContainEqual([PUSH_CHANNELS.sourceChanged, "preview-1"]);
    expect(subscribed).toContainEqual([PUSH_CHANNELS.issue, "preview-1"]);
    expect(host.on).not.toHaveBeenCalled();
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
    const controller = session();
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

  it("traces and offers the agent on an app it can only preview", async () => {
    host.handlers.set(CHANNELS.workspaceOpen, () => ({
      status: "ready",
      workspaceSessionId: "ws-1",
      appRoot: "/repo",
      support: {
        level: "preview-only",
        reasons: ["svelte 4.2.1 is installed; tested against svelte 5"],
      },
    }));
    await mountBound();
    // The rule: a Svelte version outside the supported range costs the user
    // nothing, so the panel says nothing about it. What the builder offers —
    // trace an element, hand it to an agent — is the same either way, and a
    // notice about a road that isn't there would read as a degraded panel.
    expect(screen.queryByRole("region", { name: "Site source" })).toBeNull();
    expect(screen.queryByText(/tested against svelte 5/)).toBeNull();
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Selected element" }).textContent).toContain(
      `${FILE}:6`
    );
  });
});

describe("a location the page got wrong", () => {
  it("says what the file holds there, not that the page changed", async () => {
    // A hydrated SvelteKit page can tag an element with a neighbour's location
    // (Svelte's dev `add_locations` counts a child component's root while
    // hydrating). Main finds a different tag there and says so; the drawer
    // used to render that as "Selection changed — select again", which is
    // wrong twice over: nothing changed, and selecting again gives the same
    // answer.
    host.handlers.set(CHANNELS.selectionResolve, () => ({
      status: "stale",
      mismatch: { file: FILE, line: 6, column: 2, reported: "button", found: "span" },
    }));
    await mountBound();
    await act(async () => host.select(0));
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("Couldn't select this element");
    expect(notice.textContent).toContain(`<button> at ${FILE}:6:2`);
    expect(notice.textContent).toContain("<span>");
    expect(text()).not.toContain("Selection changed");
  });

  it("reads the disagreement as the page catching up when the file just changed", async () => {
    // An agent edits the file and the page has not re-rendered yet: the old
    // location now names a different tag. That is the usual settling case,
    // not a wrong location, and must not carry the hydration advice.
    host.handlers.set(CHANNELS.selectionResolve, () => ({
      status: "stale",
      mismatch: { file: FILE, line: 6, column: 2, reported: "button", found: "p" },
    }));
    await mountBound();
    await act(async () =>
      host.pushPlugin(PUSH_CHANNELS.sourceChanged, {
        workspaceSessionId: "ws-1",
        file: FILE,
        revision: REVISION,
      })
    );
    await act(async () => host.select(0));
    await screen.findByText("This file just changed — select again");
    expect(text()).not.toContain("neighbour");
  });

  it("still reports a plain stale resolve as the page having moved on", async () => {
    host.handlers.set(CHANNELS.selectionResolve, () => ({ status: "stale" }));
    await mountBound();
    await act(async () => host.select(0));
    await screen.findByText("Selection changed — select again");
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
    host.handlers.set(CHANNELS.selectionResolve, (args) => ({
      status: "ok",
      selection: {
        ...makeSelection({ documentEpoch: args.documentEpoch as number }),
        appRoot: APP,
      },
    }));
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

  it("reports terminal activity without blocking the send, since that reading is a guess", async () => {
    // The rule: the panel may say what it SAW in the terminal, but a passive
    // output heuristic must never be the thing that stops a request going out.
    // Agent state is frequently wrong, and the advice it offers — go and look
    // at the terminal — cannot clear a reading that is stuck, so enforcing it
    // stranded a finished request with no way to send. Proof is a busy-looking
    // agent: the observation shows AND the control still works.
    usePanelStore.setState({
      // `panelIds` as well as `panelsById`: the composer's target list walks the
      // id order, so a terminal present only in the map is invisible to it.
      panelIds: ["preview-1", "term-busy"],
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", worktreeId: "wt-1" },
        "term-busy": {
          id: "term-busy",
          kind: "terminal",
          location: "grid",
          worktreeId: "wt-1",
          hasPty: true,
          title: "claude · pricing polish",
          launchAgentId: "claude",
          detectedAgentId: "claude",
          agentState: "working",
        },
      } as never,
    });
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    const send = () => screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
    await waitFor(() => expect(send().disabled).toBe(false));
    // And it is surfaced as an observation rather than swallowed.
    expect(text()).toMatch(/Activity in /);
  });

  it("headlines a delivery with what was proven, never with a reading of the agent", async () => {
    // The rule: the receipt's title states the one thing the host can vouch
    // for — that the request was sent. Anything inferred from terminal output
    // may appear, but only below it and only named as something observed. The
    // title used to append "· working" off the same heuristic, which reads as
    // confirmation that the agent picked the request up.
    usePanelStore.setState({
      panelIds: ["preview-1", "term-busy"],
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", worktreeId: "wt-1" },
        "term-busy": {
          id: "term-busy",
          kind: "terminal",
          location: "grid",
          worktreeId: "wt-1",
          hasPty: true,
          title: "claude · pricing polish",
          launchAgentId: "claude",
          detectedAgentId: "claude",
          agentState: "working",
        },
      } as never,
    });
    await mountSelected();
    updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
      draft: "",
      delivery: {
        state: { status: "sent" },
        title: "claude · pricing polish",
        terminalId: "term-busy",
      },
    });
    const notice = await screen.findByRole("status");
    // The notice's headline is its first paragraph; the body follows it.
    const headline = notice.querySelector("p")?.textContent ?? "";
    expect(headline).toContain("claude · pricing polish");
    expect(headline).not.toMatch(/working|activity/i);
    // And the observation is not suppressed either — it just lives below the
    // headline, where it reads as something seen rather than something proven.
    expect(notice.textContent ?? "").toMatch(/activity/i);
  });

  it("inserts a suggestion's whole instruction, not the short label on its chip", async () => {
    // The rule: a chip may abbreviate itself to fit, but it must never put
    // words into the draft that the user could not read before clicking. Label
    // and prompt are separate for exactly that reason, so the inserted text is
    // allowed to be longer than the label — never the other way round.
    await mountSelected();
    const chips = within(screen.getByRole("group", { name: "Suggestions" })).getAllByRole("button");
    expect(chips.length).toBeGreaterThan(0);
    const chip = chips[0]!;
    const label = chip.textContent?.trim() ?? "";
    const promised = chip.getAttribute("title") ?? "";
    expect(promised.length).toBeGreaterThan(0);
    fireEvent.click(chip);
    const request = screen.getByRole("textbox", {
      name: "Request for the agent",
    }) as HTMLTextAreaElement;
    await waitFor(() => expect(request.value).toBe(promised));
    // The chip's own words are a summary of what it sent, never the whole of it
    // when the instruction says more.
    expect(request.value.length).toBeGreaterThanOrEqual(label.length);
  });

  it("names the composer as a group, so it is reachable without a visible heading", async () => {
    // The rule: removing the visible header must not remove the accessible
    // grouping. An aria-label on a role-less div is dropped by assistive
    // technology, so the name has to sit on something with a role.
    await mountSelected();
    expect(screen.getByRole("group", { name: "Ask an agent" })).toBeTruthy();
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

  it("selects the component a crumb names, as the page would on Option+Up", async () => {
    // Clicking the page lands on the innermost thing under the pointer, and the
    // component a request should be about is usually a step or two up. The
    // trail names those steps, so each one is a control: it asks the page to
    // re-select the proven element as a member of that invocation — by call
    // site, never by label, since two nested components can share a name.
    await mountSelected();
    const strip = screen.getByRole("toolbar", { name: "Site Builder" });
    const identity = screen.getByRole("region", { name: "Selected element" });
    for (const surface of [strip, identity]) {
      expect(within(surface).getByRole("button", { name: "PricingCard" })).toBeTruthy();
    }
    // The element is where you already are: text, not a control.
    expect(within(strip).queryByRole("button", { name: 'button "Start Pro"' })).toBeNull();

    fireEvent.click(within(identity).getByRole("button", { name: "PricingCard" }));
    expect(host.sitePreview.reselect).toHaveBeenCalledTimes(1);
    expect(host.sitePreview.reselect.mock.calls[0]![0]).toEqual({
      sessionId: "session-1",
      loc: { file: FILE, line: 6, column: 2 },
      index: OBSERVATION.locIndex,
      // By the id the page reported it under first: on a hydrated page the
      // element's true location is stamped on a neighbour.
      occurrence: OBSERVATION.runtimeOccurrenceId,
      component: { file: "src/lib/PricingCard.svelte", line: 3, column: 0 },
    });
    // The page's answer is a component selection, and both surfaces follow it:
    // the drawer names the component, and the strip's trail ends at it. The
    // identity block is remounted by the resolve, so it is read afresh.
    const reselected = () => screen.getByRole("region", { name: "Selected element" });
    await waitFor(() => expect(reselected().textContent).toContain("Component"));
    expect(within(reselected()).getByText("PricingCard")).toBeTruthy();
    const trail = within(strip).getByRole("navigation", { name: "Breadcrumb" });
    expect(trail.textContent).not.toContain("Start Pro");
    expect(trail.querySelector('[aria-current="true"]')?.textContent).toBe("PricingCard");
    // Now the selection: no longer a control in either surface.
    expect(within(strip).queryByRole("button", { name: "PricingCard" })).toBeNull();
    expect(within(reselected()).queryByRole("button", { name: "PricingCard" })).toBeNull();
    // And the request is about it: the composer's About control follows the
    // page's answer, not the crumb, so it names what was actually selected.
    const about = within(reselected().parentElement!.parentElement!).getAllByRole("button", {
      name: "PricingCard",
      pressed: true,
    });
    expect(about).toHaveLength(1);
  });

  it("does not ask the page for a component while nothing is proven", async () => {
    await mountBound();
    const controller = session();
    await expect(
      controller.selectComponent({ file: "src/lib/PricingCard.svelte", line: 3, column: 0 })
    ).resolves.toBe(false);
    expect(host.sitePreview.reselect).not.toHaveBeenCalled();
  });

  it("selects the invocation a crumb names when two components share a name, and returns focus", async () => {
    // Layout > Card > Inner > Card > button: the outer Card is matched by its
    // call site, never by label; once it is the selection, the crumbs inside
    // it are the route the element was reached through, not where the
    // selection is, so they leave both trails. The focused crumb is replaced
    // by text and the trail unmounts while the source is found; a keyboard
    // user's focus comes back to the strip's current crumb, not the body.
    const outer = { file: "src/routes/+layout.svelte", line: 12, column: 0 };
    host.ancestry = [
      {
        kind: "component",
        location: { file: "src/lib/Inner.svelte", line: 8, column: 2 },
        componentTag: "Card",
        generated: false,
      },
      {
        kind: "component",
        location: { file: "src/lib/Card.svelte", line: 5, column: 4 },
        componentTag: "Inner",
        generated: false,
      },
      { kind: "component", location: outer, componentTag: "Card", generated: false },
      {
        kind: "component",
        location: { file: ".svelte-kit/generated/root.svelte", line: 1, column: 0 },
        componentTag: "Layout",
        generated: false,
      },
    ];
    await mountSelected();
    const strip = screen.getByRole("toolbar", { name: "Site Builder" });
    const cards = within(strip).getAllByRole("button", { name: "Card" });
    expect(cards).toHaveLength(2);
    cards[0]!.focus();
    fireEvent.click(cards[0]!);
    expect(host.sitePreview.reselect.mock.calls[0]![0]).toMatchObject({ component: outer });

    const trail = () => within(strip).getByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() => expect(trail().textContent).not.toContain("Inner"));
    const current = trail().querySelector('[aria-current="true"]')!;
    expect(current.textContent).toBe("Card");
    const layout = within(strip).getByRole("button", { name: "Layout" });
    expect(within(strip).queryByRole("button", { name: "Card" })).toBeNull();
    // On a control the toolbar's roving keys work from, not on the text that
    // replaced the button.
    expect(document.activeElement).toBe(layout);
    const identity = screen.getByRole("region", { name: "Selected element" });
    const drawerCrumbs = Array.from(
      within(identity).getByRole("navigation", { name: "Breadcrumb" }).querySelectorAll("li")
    )
      .filter((li) => !li.classList.contains("sr-only"))
      .map((li) => (li.textContent ?? "").trim());
    expect(drawerCrumbs).toEqual(["Layout"]);
  });

  it("offers neither surface a crumb the page could only resolve to the selection", async () => {
    // A recursive component invoked from one line twice: the page matches a
    // call site innermost first, so the outer Tree can only ever select the
    // inner one — which is already the selection. The strip sees that in its
    // own crumbs; the drawer hides the current crumb and has to be told.
    const site = { file: "src/lib/Tree.svelte", line: 4, column: 2 };
    host.ancestry = [
      { kind: "component", location: site, componentTag: "Tree", generated: false },
      { kind: "component", location: site, componentTag: "Tree", generated: false },
      {
        kind: "component",
        location: { file: "src/routes/+page.svelte", line: 9, column: 0 },
        componentTag: "Tree",
        generated: false,
      },
    ];
    await mountBound();
    await act(async () => host.select(0, [OBSERVATION], "user", { ...site, name: "Tree" }));
    const identity = await screen.findByRole("region", { name: "Selected element" });
    const strip = screen.getByRole("toolbar", { name: "Site Builder" });
    for (const surface of [strip, identity]) {
      const trees = within(surface).getAllByText("Tree");
      expect(trees.length).toBeGreaterThan(0);
      // The outermost Tree, at its own call site, is still a step up.
      expect(within(surface).getAllByRole("button", { name: "Tree" })).toHaveLength(1);
    }
  });

  it("leaves the selection alone when the page no longer has the element", async () => {
    await mountSelected();
    host.reselectFinds = false;
    const before = session().getSnapshot();
    const strip = screen.getByRole("toolbar", { name: "Site Builder" });
    fireEvent.click(within(strip).getByRole("button", { name: "PricingCard" }));
    await waitFor(() => expect(host.sitePreview.reselect).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const after = session().getSnapshot();
    expect(after.selection).toBe(before.selection);
    expect(after.selectionGeneration).toBe(before.selectionGeneration);
    expect(host.calls(CHANNELS.selectionResolve)).toHaveLength(1);
    expect(within(strip).getByRole("button", { name: "PricingCard" })).toBeTruthy();
  });

  it("offers no crumb to click while browsing", async () => {
    // The page only answers a selection request in Select mode. A crumb that
    // is a button in Browse mode is a button that does nothing.
    await mountSelected();
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await waitFor(() => expect(session().getSnapshot().mode).toBe("browse"));
    const strip = screen.getByRole("toolbar", { name: "Site Builder" });
    expect(within(strip).getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(
      "PricingCard"
    );
    expect(within(strip).queryByRole("button", { name: "PricingCard" })).toBeNull();
    const identity = screen.getByRole("region", { name: "Selected element" });
    expect(within(identity).queryByRole("button", { name: "PricingCard" })).toBeNull();
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
    const controller = session();
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
    const controller = session();
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
    const controller = session();
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
    switchOn();
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
    // Disabling the plugin switched the tool off, so coming back is switching
    // it on again — with a session that knows nothing of the closed one.
    await act(async () => {
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set() });
      switchOn();
    });
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
    // A tick later, not right away: a release deferred to a timer would pass
    // an immediate check and still detach before the remount.
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(host.sitePreview.detach).not.toHaveBeenCalled();
    mount();
    expect(screen.getByRole("region", { name: "Selected element" })).toBeTruthy();
    expect(host.sitePreview.bind).toHaveBeenCalledTimes(1);
  });

  it("releases the preview and workspace once the builder is switched off", async () => {
    await mountSelected();
    cleanup();
    await act(async () => useDevPreviewToolStore.getState().setActive("preview-1", null));
    expect(host.sitePreview.detach).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(host.calls(CHANNELS.workspaceClose)).toEqual([{ workspaceSessionId: "ws-1" }]);
  });

  it("disconnects the preview when the panel moves to another worktree", async () => {
    await mountSelected();
    cleanup();
    context.current = { projectId: "p1", worktreeId: "wt-2", worktreePath: "/repo-2" };
    await act(async () => publishDevPreviewToolContext(hostContext()));
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

describe("builder lifetime while switched on", () => {
  function builderOn() {
    usePanelStore.setState({
      panelIds: ["preview-1"],
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid" },
      } as never,
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
