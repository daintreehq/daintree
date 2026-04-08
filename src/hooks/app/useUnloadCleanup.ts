export function useUnloadCleanup() {
  // In multi-view mode each project gets its own WebContentsView that is
  // destroyed on close, so renderer-side cleanup is no longer needed.
}
