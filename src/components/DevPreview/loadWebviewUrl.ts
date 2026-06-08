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
    (result as { catch: (fn: (err: unknown) => void) => void }).catch((err: unknown) => {
      // ERR_ABORTED (-3) fires when a pending load is superseded by a new
      // navigation — benign, so don't surface it as a load failure (#9940).
      if (
        err &&
        typeof err === "object" &&
        "errorCode" in err &&
        (err as { errorCode: unknown }).errorCode === -3
      ) {
        return;
      }
      onRejected?.();
    });
  }
}
