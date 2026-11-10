/**
 * The commit panel's primary-action chord. The panel's chip and
 * `aria-keyshortcuts` name it, the message box answers it, and the hub's
 * capture-phase key handler answers it from everywhere else on the hub, so all
 * three read one definition.
 */
export function isCommitShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

/**
 * What the commit panel hands the hub's key handler to run the chord with.
 * `commitOnly` is the Shift variant, which commits without pushing.
 */
export type CommitShortcutHandler = (options: { commitOnly: boolean }) => void;
