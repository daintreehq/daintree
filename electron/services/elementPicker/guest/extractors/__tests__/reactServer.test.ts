// @vitest-environment jsdom
import { Suspense, act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentRecord } from "../../../../../../shared/elementPicker/component.js";
import type { SelectionObservation } from "../../../../../../shared/elementPicker/observation.js";
import {
  ElementPickerEventSchema,
  type ElementPickerEvent,
} from "../../../../../../shared/elementPicker/protocol.js";
import type { SourceCandidate } from "../../../../../../shared/elementPicker/source.js";
import { EXTRACTOR_REGISTRY_GLOBAL } from "../../../guestChannel.js";
import { createPicker, type PickerHandle } from "../../picker.js";
import { installExtractor } from "../../registry.js";
import { createReactExtractor } from "../reactExtractor.js";
import {
  NEXT_INTERNALS,
  TURBOPACK_LAYOUT,
  TURBOPACK_PAGE,
  WEBPACK_PAGE,
  serverChunk,
  serverElement,
  serverInfo,
  type ServerInfo,
} from "./rscFixture.js";

/**
 * The React extractor on a Next.js App Router page: server components the
 * Flight client left in `_debugInfo`, under and between the client components
 * a real react-dom rendered, read through the real picker bridge so every
 * observation is one the host would admit.
 */

const CHANNEL = "react-server-test";
const scope = globalThis as Record<string, unknown>;

let events: ElementPickerEvent[] = [];
let picker: PickerHandle | null = null;
let root: Root | null = null;
let frames: FrameRequestCallback[] = [];

beforeAll(() => {
  scope.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  events = [];
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  picker?.dispose();
  picker = null;
  (scope[EXTRACTOR_REGISTRY_GLOBAL] as { dispose(): void } | undefined)?.dispose();
  vi.unstubAllGlobals();
  delete scope.next;
  delete scope.__next_f;
  delete scope.__NEXT_DATA__;
  document.body.innerHTML = "";
});

function mount(element: ReactElement): void {
  root = createRoot(document.getElementById("root")!);
  act(() => root!.render(element));
  installExtractor(
    { channel: CHANNEL, framework: "react", installed: false },
    createReactExtractor()
  );
  picker = createPicker({
    channel: CHANNEL,
    mode: "select",
    post: (event) => {
      const parsed = ElementPickerEventSchema.safeParse(event);
      if (!parsed.success) throw new Error(`host would reject ${event.type}: ${parsed.error}`);
      events.push(event);
    },
  });
}

function query(selector: string): Element {
  const node = document.querySelector(selector);
  if (node === null) throw new Error(`no ${selector}`);
  return node;
}

function pick(selector: string): SelectionObservation {
  query(selector).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const last = events.filter((event) => event.type === "selectionChanged").at(-1);
  const observation = last?.type === "selectionChanged" ? last.observations[0] : undefined;
  if (observation === undefined) throw new Error(`nothing selected for ${selector}`);
  return observation;
}

function hover(selector: string) {
  query(selector).dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
  for (const callback of frames.splice(0)) callback(0);
  const last = events.filter((event) => event.type === "hoverChanged").at(-1);
  return last?.type === "hoverChanged" ? last.observation : null;
}

function chain(observation: SelectionObservation): Array<[string | null, string]> {
  return observation.componentChain.components.map((entry) => [
    entry.name?.value ?? null,
    entry.environment,
  ]);
}

function record(observation: SelectionObservation, name: string): ComponentRecord {
  const found = observation.componentChain.components.find((entry) => entry.name?.value === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
}

function nameOf(observation: SelectionObservation, id: string | null | undefined): string | null {
  const found = observation.componentChain.components.find((entry) => entry.componentId === id);
  return found?.name?.value ?? null;
}

function claims(component: ComponentRecord, kind: SourceCandidate["kind"]): SourceCandidate[] {
  return component.sourceCandidates.filter((candidate) => candidate.kind === kind);
}

function evidence(observation: SelectionObservation): Record<string, unknown> {
  const generic = observation.frameworkEvidence.find((entry) => entry.kind === "generic");
  return Object.fromEntries(
    (generic?.kind === "generic" ? generic.fields : []).map((entry) => [entry.name, entry.value])
  );
}

function ClientShell({ children }: { children?: ReactNode }) {
  return createElement("div", { className: "shell" }, children);
}

function ClientCard({ title }: { title: string }) {
  return createElement("button", { className: "card-action" }, title);
}

/**
 * A layout and a page, both server components, rendered into a client
 * shell; the page makes a heading of its own and a client card. Each server
 * component's output reaches the client as a lazy chunk carrying its info,
 * which is how Flight delivers a component that rendered on the server.
 */
function appRouterPage(pageFile = TURBOPACK_PAGE) {
  const layout = serverInfo("RootLayout", {
    calledFrom: [{ name: "createComponentTree", file: NEXT_INTERNALS, line: 40, column: 9 }],
    definedAt: { name: "RootLayout", file: TURBOPACK_LAYOUT, line: 12, column: 5 },
  });
  const page = serverInfo("Page", {
    calledFrom: [{ name: "createComponentTree", file: NEXT_INTERNALS, line: 52, column: 11 }],
    definedAt: { name: "Page", file: pageFile, line: 20, column: 7 },
  });
  const heading = serverElement(
    "h1",
    { className: "title", children: "Products" },
    {
      owner: page,
      key: "title",
      createdAt: [{ name: "Page", file: pageFile, line: 22, column: 9 }],
    }
  );
  const card = serverElement(
    ClientCard,
    { title: "Save" },
    { owner: page, key: "card", createdAt: [{ name: "Page", file: pageFile, line: 24, column: 9 }] }
  );
  const section = serverElement(
    "section",
    { className: "page", children: [heading, card] },
    { owner: page, createdAt: [{ name: "Page", file: pageFile, line: 21, column: 7 }] }
  );
  const main = serverElement(
    "main",
    { className: "layout", children: serverChunk(section, [page]) },
    {
      owner: layout,
      createdAt: [{ name: "RootLayout", file: TURBOPACK_LAYOUT, line: 13, column: 5 }],
    }
  );
  return { layout, page, tree: createElement(ClientShell, null, serverChunk(main, [layout])) };
}

describe("the React extractor on server components", () => {
  it("places server components in the chain between the client fibers they sit between", () => {
    mount(appRouterPage().tree);
    const heading = pick("h1.title");
    expect(chain(heading)).toEqual([
      ["Page", "server"],
      ["RootLayout", "server"],
      ["ClientShell", "client"],
    ]);
    const page = record(heading, "Page");
    expect(heading.componentChain.nearestId).toBe(page.componentId);
    expect(page.name).toEqual({
      value: "Page",
      extraction: { kind: "runtime-field", field: "_debugInfo[0].name" },
    });
    expect(nameOf(heading, page.renderParentId)).toBe("RootLayout");
    expect(nameOf(heading, record(heading, "RootLayout").renderParentId)).toBe("ClientShell");
    expect(record(heading, "ClientShell").renderParentId).toBeNull();
    expect(heading.componentChain.truncated).toBe(false);

    // A client component the page made: rendered inside it, and owned by it.
    const button = pick("button.card-action");
    expect(chain(button)).toEqual([
      ["ClientCard", "client"],
      ["Page", "server"],
      ["RootLayout", "server"],
      ["ClientShell", "client"],
    ]);
    const card = record(button, "ClientCard");
    expect(nameOf(button, card.renderParentId)).toBe("Page");
    expect(nameOf(button, card.ownerId)).toBe("Page");
    expect(record(button, "Page").ownerId).toBeNull();
    // The same instance whichever element it was reached from.
    expect(record(button, "Page").componentId).toBe(page.componentId);
  });

  it("claims no DOM of a server component's own, which it leaves none of", () => {
    mount(appRouterPage().tree);
    const heading = pick("h1.title");
    for (const name of ["Page", "RootLayout"]) {
      expect(record(heading, name)).toMatchObject({ rootElementIds: [], rootsComplete: false });
    }
    expect(record(heading, "ClientShell").rootElementIds).toHaveLength(1);
    // Only the client shell can be selected as a component on the page.
    expect(heading.capabilities.componentSelection).toEqual({ state: "available" });
  });

  it("reports where a server component was used and where it is written, raw, as the server ran them", () => {
    mount(appRouterPage().tree);
    const heading = pick("h1.title");
    const page = record(heading, "Page");
    const [used] = claims(page, "component-invocation");
    expect(used).toMatchObject({
      extraction: {
        kind: "generated-stack-frame",
        field: "_debugInfo[0].debugStack",
        frameIndex: 1,
      },
      location: { line: 52, column: 11 },
    });
    expect(used?.file).toMatch(/^about:\/\/React\/Server\/file:\/\/\/work\/app\/\.next\//);
    const [defined] = claims(page, "component-definition");
    expect(defined).toMatchObject({
      extraction: {
        kind: "generated-stack-frame",
        field: "_debugInfo[0].debugLocation",
        frameIndex: 1,
      },
      location: { line: 20, column: 7 },
    });
    expect(decodeURI(defined!.file)).toContain("__page._.js");
    // The element itself was made on the server too, in the page's code.
    expect(heading.sourceCandidates[0]).toMatchObject({
      kind: "element-creation",
      location: { line: 22, column: 9 },
    });
    expect(heading.capabilities.file).toEqual({ state: "unknown" });
  });

  it("claims no definition from a location that names some other function", () => {
    const page = serverInfo("Page", {
      definedAt: { name: "renderLayout", file: TURBOPACK_PAGE, line: 3, column: 1 },
    });
    mount(
      createElement(
        ClientShell,
        null,
        serverChunk(serverElement("p", { className: "lone" }, { owner: page }), [page])
      )
    );
    expect(claims(record(pick("p.lone"), "Page"), "component-definition")).toEqual([]);
  });

  it("names the nearest server component on hover, and nothing more", () => {
    mount(appRouterPage().tree);
    const observation = hover("h1.title");
    expect(observation?.componentChain.components).toHaveLength(1);
    expect(observation?.componentChain.components[0]).toMatchObject({
      name: { value: "Page" },
      environment: "server",
      rootElementIds: [],
      sourceCandidates: [],
    });
    expect(observation?.componentChain.nearestId).toBe(pick("h1.title").componentChain.nearestId);
    // A client component nearer still wins.
    expect(hover("button.card-action")?.componentChain.components[0]?.name?.value).toBe(
      "ClientCard"
    );
  });

  it("tells instances apart by their info, never by name", () => {
    const list = serverInfo("List");
    const first = serverInfo("Item", { owner: list });
    const second = serverInfo("Item", { owner: list });
    const items = [
      serverChunk(serverElement("li", { className: "one" }, { owner: first, key: "one" }), [first]),
      serverChunk(serverElement("li", { className: "two" }, { owner: second, key: "two" }), [
        second,
      ]),
      serverElement("li", { className: "three" }, { owner: list, key: "three" }),
    ];
    mount(
      createElement(
        ClientShell,
        null,
        serverChunk(serverElement("ul", { children: items }, { owner: list }), [list])
      )
    );
    const one = pick("li.one");
    const two = pick("li.two");
    expect(chain(one)).toEqual([
      ["Item", "server"],
      ["List", "server"],
      ["ClientShell", "client"],
    ]);
    expect(record(one, "Item").componentId).not.toBe(record(two, "Item").componentId);
    expect(record(one, "List").componentId).toBe(record(two, "List").componentId);
    expect(nameOf(one, record(one, "Item").ownerId)).toBe("List");
    // An element the list made itself, with no component of its own between.
    expect(chain(pick("li.three"))).toEqual([
      ["List", "server"],
      ["ClientShell", "client"],
    ]);
  });

  it("reads only component entries, and labels one with no environment unknown", () => {
    const page = serverInfo("Page");
    const bare = { ...serverInfo("Bare"), env: undefined };
    mount(
      createElement(
        ClientShell,
        null,
        serverChunk(serverElement("p", { className: "mixed" }, { owner: page }), [
          { time: 12 },
          { awaited: { name: "fetch", start: 1, end: 2 }, env: "Server", owner: page },
          bare,
          page,
          { time: 13 },
        ])
      )
    );
    expect(chain(pick("p.mixed"))).toEqual([
      ["Page", "server"],
      ["Bare", "unknown"],
      ["ClientShell", "client"],
    ]);
  });

  it("follows a server component's owner out of the render chain without inventing its render parent", () => {
    const shell = serverInfo("Shell");
    const page = serverInfo("Page", { owner: shell });
    mount(
      createElement(
        ClientShell,
        null,
        serverChunk(serverElement("p", { className: "owned" }, { owner: page }), [page])
      )
    );
    const observation = pick("p.owned");
    expect(chain(observation)).toEqual([
      ["Page", "server"],
      ["ClientShell", "client"],
      ["Shell", "server"],
    ]);
    const owner = record(observation, "Shell");
    expect(nameOf(observation, record(observation, "Page").ownerId)).toBe("Shell");
    expect(owner).not.toHaveProperty("renderParentId");
    expect(owner.name?.extraction).toEqual({
      kind: "runtime-field",
      field: "_debugInfo[0].owner.name",
    });
  });

  it("cuts a server owner loop rather than sending it", () => {
    const a = serverInfo("A");
    const b = serverInfo("B", { owner: a });
    (a as { owner: ServerInfo | null }).owner = b;
    mount(
      createElement(
        ClientShell,
        null,
        serverChunk(serverElement("p", { className: "loop" }, { owner: b }), [a, b])
      )
    );
    const observation = pick("p.loop");
    expect(chain(observation).map(([name]) => name)).toEqual(["B", "A", "ClientShell"]);
    expect(observation.componentChain.truncated).toBe(true);
  });

  it("survives a page that makes its debug info throw", () => {
    const hostile = serverChunk(serverElement("p", { className: "hostile" }), []);
    mount(createElement(ClientShell, null, hostile));
    const node = query("p.hostile") as unknown as Record<string, Record<string, unknown>>;
    const key = Object.keys(node).find((entry) => entry.startsWith("__reactFiber$"))!;
    Object.defineProperty(node[key]!, "_debugInfo", {
      configurable: true,
      get: () => {
        throw new Error("hostile");
      },
    });
    expect(chain(pick("p.hostile"))).toEqual([["ClientShell", "client"]]);
  });

  it("reads debug info that streamed in after the content mounted, at each pick", async () => {
    const reviews = serverInfo("Reviews");
    const late: unknown[] = [];
    let resolved = false;
    let settle!: () => void;
    const ready = new Promise<void>((resolve) => (settle = resolve));
    // A Flight chunk still streaming: its status is what React's key check reads.
    const pending = {
      $$typeof: Symbol.for("react.lazy"),
      _payload: { status: "pending", value: null },
      _init: () => {
        if (!resolved) throw ready;
        return serverElement("ul", { className: "reviews" }, { owner: reviews });
      },
      _debugInfo: late,
    } as unknown as ReactElement;
    mount(
      createElement(
        ClientShell,
        null,
        createElement(Suspense, { fallback: createElement("i", { className: "loading" }) }, pending)
      )
    );
    expect(chain(pick("i.loading"))).toEqual([["ClientShell", "client"]]);
    await act(async () => {
      resolved = true;
      settle();
      await ready;
    });
    expect(chain(pick("ul.reviews"))).toEqual([["ClientShell", "client"]]);
    // The row naming the component arrives after the content: the same fiber, read again.
    late.push(reviews);
    expect(chain(pick("ul.reviews"))).toEqual([
      ["Reviews", "server"],
      ["ClientShell", "client"],
    ]);
  });

  it("reports the Next.js version and router the page runs, as the page reports them", () => {
    scope.next = { version: "16.0.3", appDir: true };
    scope.__next_f = [];
    mount(appRouterPage(WEBPACK_PAGE).tree);
    const heading = pick("h1.title");
    expect(evidence(heading)).toMatchObject({ nextVersion: "16.0.3", nextRouter: "app" });
    expect(claims(record(heading, "Page"), "component-definition")[0]?.file).toContain(
      encodeURI(WEBPACK_PAGE)
    );
  });

  it("leaves a version that is not one out of the evidence", () => {
    scope.next = { version: "16.0.3\n<script>" };
    mount(appRouterPage().tree);
    expect(evidence(pick("h1.title"))).not.toHaveProperty("nextVersion");
  });
});

describe("the React extractor on the Pages Router", () => {
  it("reads the client tree as before, with no server ancestry", () => {
    scope.next = { version: "16.0.3" };
    scope.__NEXT_DATA__ = { buildId: "development", page: "/" };
    mount(createElement(ClientShell, null, createElement(ClientCard, { title: "Save" })));
    const button = pick("button.card-action");
    expect(chain(button)).toEqual([
      ["ClientCard", "client"],
      ["ClientShell", "client"],
    ]);
    expect(evidence(button)).toMatchObject({ nextVersion: "16.0.3", nextRouter: "pages" });
    expect(claims(record(button, "ClientCard"), "component-definition")).toHaveLength(1);
  });
});
