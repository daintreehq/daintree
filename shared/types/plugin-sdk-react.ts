/**
 * Reserved entry point for `@daintreehq/plugin-sdk/react`.
 *
 * No exports in v1. React hooks (`useWorktrees`, `useActiveWorktree`, etc.)
 * are planned for F15/F36. This module exists so the import path resolves and
 * TypeScript emits declarations for the subpath — plugin authors can reference
 * `@daintreehq/plugin-sdk/react` today and it will resolve to an empty module.
 */
export type {};
