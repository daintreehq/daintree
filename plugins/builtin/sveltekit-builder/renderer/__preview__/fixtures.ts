import type { PtyPanelData } from "@shared/types/panel";
import { CHANNELS, PUSH_CHANNELS } from "../../shared/protocol.js";
import { composerMemoryKey, updateComposerMemory } from "../composerMemory.js";
import {
  COMPONENT_FILE,
  FILE,
  OBSERVATION,
  REVISION,
  makeReceipt,
  makeSelection,
  type PreviewHostHandle,
} from "./previewHost.js";

export const PANEL_ID = "preview-1";
export const WORKTREE_ID = "wt-1";
/** The composer's own key for this preview and worktree, from its own function. */
const MEMORY_KEY = composerMemoryKey(PANEL_ID, WORKTREE_ID);

/**
 * One named state of the Site Builder, reached the way the app reaches it:
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

/** The button in the surfaces whose trimmed label is exactly `label`. */
/**
 * The "Edit directly" disclosure trigger. A real button with `aria-expanded`
 * now, rather than a native `summary` — found by its accessible role so the
 * fixture exercises the same contract a keyboard user gets.
 */
function summary(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (node) => node.hasAttribute("aria-expanded") && node.textContent?.trim() === "Edit directly"
  );
}

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
    title: "Select mode, waiting for a click on the page",
    settled: "text=Click any element on the page",
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
    settled: "text=Ask an agent",
    act: selectElement,
  },

  component: {
    title: "A component picked rather than the element inside it",
    terminals: AGENT_TERMINALS,
    settled: "text=Ask an agent",
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
    settled: "text=Ask an agent",
    act: async (host) => {
      await selectElement(host);
      updateComposerMemory(MEMORY_KEY, {
        draft: "Make this button feel more premium — softer corners and a calmer hover.",
      });
      await tick(120);
    },
  },

  edits: {
    title: "The direct text and class editors, disclosed",
    terminals: AGENT_TERMINALS,
    settled: "text=Edit directly",
    act: async (host) => {
      await selectElement(host);
      await until("the Edit directly disclosure", () => summary() !== undefined);
      if (summary()!.getAttribute("aria-expanded") !== "true") summary()!.click();
      await until(
        "the class tokens",
        () => document.querySelector('[aria-label="Classes"]') !== null
      );
      await tick(160);
    },
  },

  receipt: {
    title: "What the last saved change proved, with undo",
    terminals: AGENT_TERMINALS,
    // The receipt's own headline, not its aria-label: the proof has to be
    // something a reviewer can see in the capture.
    settled: '[aria-label="Last change"]',
    arrange: (host) => {
      host.handlers.set(CHANNELS.editApply, () => ({
        status: "applied",
        receipt: makeReceipt({ affectedOccurrences: 3 }),
      }));
    },
    act: async (host) => {
      await selectElement(host);
      await until("the Edit directly disclosure", () => summary() !== undefined);
      if (summary()!.getAttribute("aria-expanded") !== "true") summary()!.click();
      await until(
        "the class tokens",
        () => document.querySelector('[aria-label="Classes"]') !== null
      );
      await until(
        "the px-6 class token",
        () => document.querySelector('button[aria-label="Remove px-6"]') !== null
      );
      document.querySelector<HTMLButtonElement>('button[aria-label="Remove px-6"]')!.click();
      await until("the edit receipt", () => seen("Classes saved in +page.svelte"));
      // The receipt is the last thing in a drawer that already holds a notice,
      // the composer and both editors, so on a laptop viewport it lands below
      // the fold. Scroll to it: the capture is about the receipt.
      const drawer = document.querySelector('[aria-label="Site Builder details"]');
      if (drawer) drawer.scrollTop = drawer.scrollHeight;
      await tick(160);
    },
  },

  stale: {
    title: "The source moved under a live selection",
    terminals: AGENT_TERMINALS,
    // Proves the staleness, not merely that the drawer is open.
    settled: "text=Source changed — select again",
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

  multiple: {
    title: "The picked markup draws several copies on the page",
    terminals: AGENT_TERMINALS,
    settled: "text=Edit directly",
    arrange: (host) => {
      host.handlers.set(CHANNELS.selectionResolve, (args) => ({
        status: "ok",
        selection: makeSelection({
          documentEpoch: args.documentEpoch as number,
          renderedOccurrences: 4,
        }),
      }));
    },
    act: async (host) => {
      await selectElement(host);
      await until("the Edit directly disclosure", () => summary() !== undefined);
      if (summary()!.getAttribute("aria-expanded") !== "true") summary()!.click();
      await until(
        "the class tokens",
        () => document.querySelector('[aria-label="Classes"]') !== null
      );
      await tick(160);
    },
  },

  unsupported: {
    title: "The project cannot be edited directly, and why",
    settled: "text=Editing isn't supported for this project",
    arrange: (host) => {
      host.handlers.set(CHANNELS.workspaceOpen, () => ({
        status: "ready",
        workspaceSessionId: "ws-1",
        appRoot: "/Users/you/code/orchid-studio",
        support: {
          level: "preview-only",
          reasons: [
            "Svelte 4.2.19 found — direct editing needs Svelte 5",
            "No Tailwind config found under the app root, so class suggestions are unavailable",
          ],
        },
      }));
    },
    act: bind,
  },

  ambiguous: {
    title: "Several SvelteKit apps in the worktree — which one is this?",
    settled: "text=Which app is this preview showing?",
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
        delivery: {
          state: { status: "sent" },
          title: "claude · pricing polish",
          terminalId: "term-1",
        },
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
        delivery: {
          state: {
            status: "failed",
            message: "The terminal stopped accepting input",
            partial: true,
          },
          title: "claude · pricing polish",
          terminalId: "term-1",
        },
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
