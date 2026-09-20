import type { PtyPanelData } from "@shared/types/panel";
import { CHANNELS, PUSH_CHANNELS } from "../../shared/protocol.js";
import { composerMemoryKey, updateComposerMemory } from "../composerMemory.js";
import {
  COMPONENT_FILE,
  FILE,
  OBSERVATION,
  REVISION,
  makeSelection,
  type PreviewHostHandle,
} from "./previewHost.js";

export const PANEL_ID = "preview-1";
export const WORKTREE_ID = "wt-1";
/** The composer's own key for this preview and worktree, from its own function. */
const MEMORY_KEY = composerMemoryKey(PANEL_ID, WORKTREE_ID);

/**
 * One named state of SvelteKit Tools, reached the way the app reaches it:
 * fixtures reshape the host's answers and then push the same guest events the
 * real bridge pushes, so the controller, its state machine and both surfaces
 * are the real ones. Nothing here draws a picture of a state — it drives one.
 */
export interface SiteBuilderFixture {
  /** Sentence describing what the reviewer is looking at. */
  readonly title: string;
  /** Agent terminals in this worktree, for the composer's destination list. */
  readonly terminals?: ReadonlyArray<Partial<PtyPanelData> & { id: string }>;
  /** Reshape host answers BEFORE the surfaces mount. */
  readonly arrange?: (host: PreviewHostHandle) => void;
  /** Drive the mounted surfaces into the state. Awaited before the page is ready. */
  readonly act?: (host: PreviewHostHandle) => Promise<void> | void;
  /**
   * A selector the harness waits for before it calls the state reached. A
   * fixture with no proof is a fixture that can silently capture the wrong
   * screen, so every one carries it.
   */
  readonly settled: string;
}

const AGENT_TERMINALS = [
  { id: "term-1", launchAgentId: "claude", detectedAgentId: "claude", agentState: "idle" },
  { id: "term-2", launchAgentId: "codex", detectedAgentId: "codex", agentState: "idle" },
] as const;

const SAMPLE_REQUEST = [
  "Make the Pro plan stand out more",
  "",
  "---",
  "",
  "Context from Daintree's SvelteKit Tools — file references only; read the files for the code:",
  "- Worktree: /Users/you/code/orchid-studio",
  "- App: the worktree root (SvelteKit 2.36.0, Svelte 5.38.1, Tailwind 4.1.12)",
  "- Page: http://localhost:5173/pricing (route /pricing)",
  "- Viewport: 1280×800",
  "- Route files, outermost layout first:",
  "  - layout: src/routes/+layout.svelte",
  "  - data: src/routes/pricing/+page.server.ts",
  "  - page: src/routes/pricing/+page.svelte",
  '- Selected element: button "Start Pro"',
  "- Source: <button> at src/routes/pricing/+page.svelte:6:3",
  "",
  "Keep the change to this element unless the request needs more. If it needs a wider change, say so and name what else you touched.",
].join("\n");

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll until a predicate holds. Every wait in a fixture is for something the
 * controller does asynchronously — an IPC round trip, a definitions lookup —
 * and a fixed sleep either flakes on a loaded machine or pads every capture.
 * Throws rather than returning false: the harness must never photograph a state
 * it could not reach.
 */
async function until(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(50);
  }
  throw new Error(`site-builder fixture: timed out waiting for ${what}`);
}

const seen = (text: string): boolean => (document.body.textContent ?? "").includes(text);

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label
  );
}

/** Bound to the page with a document in it — the floor every other fixture builds on. */
async function bind(host: PreviewHostHandle): Promise<void> {
  await tick(60);
  host.documentReady(0);
  await tick(60);
}

async function selectElement(host: PreviewHostHandle): Promise<void> {
  await bind(host);
  host.select(0);
  // The strip names the picked element once main has resolved its source; that
  // is the first moment the drawer holds anything worth photographing.
  await until("the resolved selection", () => seen('button "Start Pro"'));
}

export const FIXTURES = {
  browsing: {
    title: "Browse mode, bound to the page, nothing picked",
    settled: "text=Browsing",
    act: async (host) => {
      await bind(host);
      // The builder opens in Select; Browse is a mode the user switches to, so
      // the fixture switches to it the same way.
      await until("the Browse option", () => button("Browse") !== undefined);
      button("Browse")!.click();
      await until("browse mode on the strip", () => seen("Browsing"));
    },
  },

  picking: {
    title: "Inspect mode, waiting for a click on the page",
    settled: "text=Click an element to ask an agent about it",
    act: async (host) => {
      await bind(host);
    },
  },

  connecting: {
    title: "Attaching to a dev preview that has not answered yet",
    settled: "text=Connecting to the page",
    arrange: (host) => {
      host.control.stallBind = true;
    },
    act: async () => {
      // Past the Doherty gate the waiting row sits behind, so the row is really
      // on screen rather than merely pending.
      await tick(700);
    },
  },

  element: {
    title: "An element picked: identity, source line, breadcrumb, composer",
    terminals: AGENT_TERMINALS,
    settled: '[aria-label="Ask an agent"]',
    act: selectElement,
  },

  component: {
    title: "A component picked rather than the element inside it",
    terminals: AGENT_TERMINALS,
    settled: '[aria-label="Ask an agent"]',
    act: async (host) => {
      await selectElement(host);
      // Walking up to the component scope is what ⌥↑ does in the page.
      await until("the PricingCard scope chip", () => button("PricingCard") !== undefined);
      button("PricingCard")!.click();
      await tick(150);
    },
  },

  composing: {
    title: "A request written, an agent chosen, ready to send",
    terminals: AGENT_TERMINALS,
    settled: '[aria-label="Ask an agent"]',
    act: async (host) => {
      await selectElement(host);
      updateComposerMemory(MEMORY_KEY, {
        draft: "Make this button feel more premium — softer corners and a calmer hover.",
      });
      await tick(120);
    },
  },

  stale: {
    title: "The source moved under a live selection",
    terminals: AGENT_TERMINALS,
    // Proves the staleness, not merely that the drawer is open.
    settled: "text=Select again — the file changed",
    act: async (host) => {
      await selectElement(host);
      // Plugin main's own push channel, not the preview bridge: this is main
      // telling the view that a file under the open workspace moved — an agent
      // writing to it, typically.
      host.pushPlugin(PUSH_CHANNELS.sourceChanged, {
        workspaceSessionId: "ws-1",
        file: FILE,
        revision: `${REVISION.slice(0, 60)}feed`,
      });
      await tick(220);
    },
  },

  deepScope: {
    title: "A deep component chain with repeated names, as a list",
    terminals: AGENT_TERMINALS,
    settled: '[aria-label="Ask an agent"]',
    arrange: (host) => {
      const chain = [
        ["PriceTag", "src/lib/pricing/Card.svelte", 14],
        ["Card", "src/lib/pricing/Grid.svelte", 9],
        ["Grid", "src/routes/pricing/+page.svelte", 22],
        ["Card", "src/routes/pricing/+page.svelte", 40],
        ["Section", "src/routes/+layout.svelte", 12],
      ] as const;
      host.handlers.set(CHANNELS.selectionResolve, (args) => ({
        status: "ok",
        selection: makeSelection({
          documentEpoch: args.documentEpoch as number,
          node: {
            ancestry: chain.map(([name, file, line]) => ({
              kind: "component" as const,
              location: { file, line, column: 2 },
              componentTag: name,
              generated: false,
            })),
          },
        }),
      }));
    },
    act: async (host) => {
      await selectElement(host);
      await until(
        "the scope list",
        () => document.querySelector('[aria-label="What the request is about"]') !== null
      );
      await tick(160);
    },
  },

  appSwitcher: {
    title: "A worktree with several apps keeps a switcher once one is open",
    settled: "text=Site source",
    arrange: (host) => {
      const roots = [
        "/Users/you/code/orchid-studio/apps/marketing",
        "/Users/you/code/orchid-studio/apps/docs",
      ];
      host.handlers.set(CHANNELS.workspaceOpen, (args) =>
        args.appRoot
          ? {
              status: "ready",
              workspaceSessionId: "ws-1",
              appRoot: args.appRoot,
              support: { level: "tested" },
            }
          : { status: "ambiguous", appRoots: roots }
      );
    },
    act: async (host) => {
      await bind(host);
      await until("the app choice", () => button("apps/marketing") !== undefined);
      button("apps/marketing")!.click();
      await until(
        "the app switcher",
        () => document.querySelector('[aria-label="Site source app"]') !== null
      );
      await tick(160);
    },
  },

  requestRecord: {
    title: "A sent request with the exact text it typed in, expanded",
    terminals: AGENT_TERMINALS,
    settled: '[aria-label="Request text"]',
    act: async (host) => {
      await selectElement(host);
      updateComposerMemory(MEMORY_KEY, {
        draft: "",
        deliveries: [
          {
            id: "request-1",
            instruction: "Make this button feel more premium",
            subject: null,
            state: { status: "sent" },
            title: "claude · pricing polish",
            terminalId: "term-1",
            request: SAMPLE_REQUEST,
          },
        ],
      });
      await until("View request", () => button("View request") !== undefined);
      button("View request")!.click();
      await tick(160);
    },
  },

  ambiguous: {
    title: "Several SvelteKit apps in the worktree — which one is this?",
    settled: "text=More than one SvelteKit app lives in this worktree",
    arrange: (host) => {
      host.handlers.set(CHANNELS.workspaceOpen, () => ({
        status: "ambiguous",
        appRoots: [
          "/Users/you/code/orchid-studio",
          "/Users/you/code/orchid-studio/apps/marketing",
          "/Users/you/code/orchid-studio/apps/docs",
        ],
      }));
    },
    act: bind,
  },

  workspaceFailed: {
    title: "The source workspace refused to open",
    settled: "text=Couldn't open the site source",
    arrange: (host) => {
      // Main rejects; the view has no `failed` variant on the wire, so a real
      // failure arrives as a thrown error, not as a status.
      host.handlers.set(CHANNELS.workspaceOpen, () => {
        throw new Error("EACCES: permission denied, open 'vite.config.ts'");
      });
    },
    act: bind,
  },

  sent: {
    title: "A request delivered to an agent, with what the host can prove",
    terminals: AGENT_TERMINALS,
    settled: "text=Sent to",
    act: async (host) => {
      await selectElement(host);
      updateComposerMemory(MEMORY_KEY, {
        // Cleared, as `deliverAgentRequest` clears it once the send is proven.
        draft: "",
        deliveries: [
          {
            id: "request-1",
            instruction: "Make this button feel more premium",
            subject: null,
            state: { status: "sent" },
            title: "claude · pricing polish",
            terminalId: "term-1",
            request: SAMPLE_REQUEST,
          },
        ],
      });
      await tick(140);
    },
  },

  sendFailed: {
    title: "Delivery failed part-way into the agent's input",
    terminals: AGENT_TERMINALS,
    settled: "text=Couldn't send to the agent",
    act: async (host) => {
      await selectElement(host);
      updateComposerMemory(MEMORY_KEY, {
        draft: "Make this button feel more premium — softer corners and a calmer hover.",
        deliveries: [
          {
            id: "request-1",
            instruction: "Make this button feel more premium",
            subject: null,
            state: {
              status: "failed",
              message: "The terminal stopped accepting input",
              partial: true,
            },
            title: "claude · pricing polish",
            terminalId: "term-1",
          },
        ],
      });
      await tick(140);
    },
  },

  detached: {
    title: "The inspector lost the preview it was attached to",
    settled: "text=Another inspector connected to this preview",
    act: async (host) => {
      await bind(host);
      host.detach("rebound");
      await tick(160);
    },
  },
} as const satisfies Record<string, SiteBuilderFixture>;

export type FixtureName = keyof typeof FIXTURES;

/**
 * `as const satisfies` keeps the key literals for `FixtureName`, but it also
 * narrows each entry to its own literal type — so an optional member absent
 * from one fixture is absent from the union and unreachable. Read through here.
 */
export const fixtureFor = (name: FixtureName): SiteBuilderFixture => FIXTURES[name];
export const FIXTURE_NAMES = Object.keys(FIXTURES) as FixtureName[];
export const isFixtureName = (value: string): value is FixtureName =>
  Object.prototype.hasOwnProperty.call(FIXTURES, value);

export { COMPONENT_FILE, FILE, OBSERVATION, REVISION };
