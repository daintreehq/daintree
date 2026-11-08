/**
 * Start this project view over from a fresh load. Its own module so a test can
 * observe the reload, which jsdom can't do on `location`.
 */
export function reloadView(): void {
  window.location.reload();
}
