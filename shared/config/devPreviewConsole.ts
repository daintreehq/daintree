/**
 * Maximum console rows retained per dev-preview pane.
 *
 * Shared because both ends of the console pipeline evict against it and they
 * must not drift: `consoleCaptureStore` caps the rows it keeps, and the main
 * process caps the per-row CDP remote-object owner records it keeps, releasing
 * the handles of rows that have aged past the same boundary. If the two caps
 * diverge, main either releases handles for rows still on screen or leaks
 * handles for rows the renderer has already dropped.
 */
export const MAX_CONSOLE_ROWS = 500;
