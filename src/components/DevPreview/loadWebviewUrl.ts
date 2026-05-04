export function loadWebviewUrl(
  webview: Electron.WebviewTag,
  url: string,
  onRejected?: () => void
): void {
  const result = (webview.loadURL as (url: string) => unknown)(url);
  if (
    result &&
    typeof result === "object" &&
    "catch" in result &&
    typeof result.catch === "function"
  ) {
    result.catch(() => {
      onRejected?.();
    });
  }
}
