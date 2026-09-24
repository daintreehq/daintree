/**
 * What the shortcut-hint harness renders. Each fixture is one real teaching
 * moment: the action's title, the combo exactly as the keybinding registry
 * stores it, the platform it is shown on, and where the pointer was.
 */
export interface ShortcutHintFixture {
  title: string;
  combo: string;
  platform: "mac" | "win";
  /** Pointer position, as a fraction of the preview frame. */
  anchor: { x: number; y: number };
}

export const SHORTCUT_HINT_FIXTURES = {
  single: {
    title: "Toggle sidebar",
    combo: "Cmd+B",
    platform: "mac",
    anchor: { x: 0.3, y: 0.62 },
  },
  triple: {
    title: "Open command palette",
    combo: "Cmd+Shift+P",
    platform: "mac",
    anchor: { x: 0.3, y: 0.62 },
  },
  chord: {
    title: "Open keyboard shortcuts",
    combo: "Cmd+K Cmd+S",
    platform: "mac",
    anchor: { x: 0.3, y: 0.62 },
  },
  untitled: {
    title: "",
    combo: "Cmd+Alt+L",
    platform: "mac",
    anchor: { x: 0.3, y: 0.62 },
  },
  "long-title": {
    title: "Restart every agent in the current worktree",
    combo: "Cmd+Alt+Shift+R",
    platform: "mac",
    anchor: { x: 0.3, y: 0.62 },
  },
  "win-triple": {
    title: "Open command palette",
    combo: "Cmd+Shift+P",
    platform: "win",
    anchor: { x: 0.3, y: 0.62 },
  },
  "win-chord": {
    title: "Open keyboard shortcuts",
    combo: "Cmd+K Cmd+S",
    platform: "win",
    anchor: { x: 0.3, y: 0.62 },
  },
  "top-edge": {
    title: "Toggle sidebar",
    combo: "Cmd+B",
    platform: "mac",
    anchor: { x: 0.3, y: 0.04 },
  },
  "right-edge": {
    title: "Open command palette",
    combo: "Cmd+Shift+P",
    platform: "mac",
    anchor: { x: 0.97, y: 0.62 },
  },
} satisfies Record<string, ShortcutHintFixture>;

export type ShortcutHintFixtureName = keyof typeof SHORTCUT_HINT_FIXTURES;

export function requireShortcutHintFixture(name: string): ShortcutHintFixture {
  const fixture = (SHORTCUT_HINT_FIXTURES as Record<string, ShortcutHintFixture>)[name];
  if (!fixture) throw new Error(`unknown shortcut-hint fixture "${name}"`);
  return fixture;
}
