import type { FileEditorHintBarProps } from "../FileEditorHintBar";

type Fixture = Omit<FileEditorHintBarProps, "onAction" | "onDismiss">;

/**
 * The states the hint bar has to look right in. `disabled` and `ready` differ
 * only in copy, which is exactly why they are captured side by side — the whole
 * question is whether a reader can tell the prerequisite apart from the offer.
 */
export const HINT_BAR_FIXTURES: Record<string, Fixture> = {
  ready: { pluginName: "Markdown editor", state: "ready", pending: false, error: null },
  disabled: { pluginName: "Markdown editor", state: "disabled", pending: false, error: null },
  pending: { pluginName: "Markdown editor", state: "disabled", pending: true, error: null },
  error: {
    pluginName: "Markdown editor",
    state: "disabled",
    pending: false,
    error: "The plugin couldn't start. Check its status in Preferences → Plugins.",
  },
  "long-name": {
    pluginName: "Markdown editor with a deliberately long display name",
    state: "disabled",
    pending: false,
    error: null,
  },
};

export function requireHintBarFixture(name: string): Fixture {
  const fixture = HINT_BAR_FIXTURES[name];
  if (!fixture) {
    throw new Error(
      `unknown hint-bar fixture "${name}" — have ${Object.keys(HINT_BAR_FIXTURES).join(", ")}`
    );
  }
  return fixture;
}
