import { createContext, useContext, type ComponentType } from "react";

/**
 * The mockup kit draws from what it is handed, never from the app: agents,
 * state glyphs and CI marks all arrive as data through this context (or as a
 * descriptor on a single component), so a plugin tour can show any agent.
 */
export type MockGlyph = ComponentType<{ className?: string }>;

/** Built-in ids keep autocomplete; any other id is still accepted. */
export type MockAgentId = "claude" | "codex" | "antigravity" | (string & {});

export interface MockAgent {
  id: MockAgentId;
  name: string;
  Icon: MockGlyph | null;
  /** CSS colour the icon inherits through `currentColor`. */
  color?: string;
}

export type MockStateId =
  | "working"
  | "waiting"
  | "directing"
  | "completed"
  | "exited"
  | "idle"
  | (string & {});

export interface MockStateVisual {
  /** Null keeps the glyph's box empty, as the real header does for idle. */
  Icon: MockGlyph | null;
  colorClass: string;
  /** Extra classes on the icon itself, e.g. the working spinner's rotation. */
  iconClassName?: string;
}

export type MockCIVisual =
  | { kind: "icon"; Icon: MockGlyph; colorClass: string }
  | { kind: "dot"; colorClass: string };

export interface MockKit {
  agents: Readonly<Record<string, MockAgent>>;
  states: Readonly<Record<string, MockStateVisual>>;
  /** Most urgent first: a worktree card shows the first of its states found here. */
  statePriority: readonly MockStateId[];
  ci: Readonly<Record<string, MockCIVisual>>;
  /** The host app's own mark, shown on the toolbar's assistant button. */
  assistantIcon: MockGlyph | null;
}

export const EMPTY_MOCK_KIT: MockKit = {
  agents: {},
  states: {},
  statePriority: [],
  ci: {},
  assistantIcon: null,
};

export const MockKitContext = createContext<MockKit>(EMPTY_MOCK_KIT);

export function useMockKit(): MockKit {
  return useContext(MockKitContext);
}

function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** An id the kit doesn't know still renders: no icon, its id as the name. */
export function resolveMockAgent(kit: MockKit, agent: MockAgentId | MockAgent): MockAgent {
  if (typeof agent !== "string") return agent;
  return lookup(kit.agents, agent) ?? { id: agent, name: agent, Icon: null };
}

export function resolveMockState(kit: MockKit, state: MockStateId): MockStateVisual | undefined {
  return lookup(kit.states, state);
}

export function resolveMockCI(
  kit: MockKit,
  status: string | MockCIVisual
): MockCIVisual | undefined {
  return typeof status === "string" ? lookup(kit.ci, status) : status;
}
