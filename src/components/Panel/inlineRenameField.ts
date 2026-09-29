/**
 * The one look and input contract for renaming a pane in place — its header title
 * and its tab. Chrome-free by ruling (#7926): a soft wash at rest, and while the
 * field has focus the wash deepens and its edge appears. No accent.
 */
export const inlineRenameFieldClassName =
  "rounded-sm border border-transparent bg-overlay-soft px-1 text-xs font-medium text-text-primary select-text transition-colors focus:outline-hidden focus-visible:border-divider focus-visible:bg-overlay-medium";

/** Pane names are identifiers ("fix-auth-tests"), not prose. */
export const inlineRenameFieldInputProps = {
  type: "text",
  spellCheck: false,
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
} as const;
