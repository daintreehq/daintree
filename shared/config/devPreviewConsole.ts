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

/**
 * How many of a pane's newest console rows keep their logged objects alive for
 * inspection. Every live handle pins its object graph in the guest page's heap
 * whether or not the console drawer is open, so older rows keep only their
 * preview text. A row the user has expanded keeps its handles until it falls
 * past {@link MAX_CONSOLE_ROWS}.
 *
 * Shared for the same reason as the row cap: main releases a row's handles as
 * it leaves this window, and the store strips the row's object ids at the same
 * point, so the console never offers to expand a value that is gone.
 */
export const MAX_LIVE_OBJECT_ROWS = 50;
