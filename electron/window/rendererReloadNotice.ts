/**
 * Toast copy for a renderer that died and was reloaded. A `killed` renderer
 * was signalled from outside (a stray `pkill`), so calling it a crash would
 * point users and bug reports at Daintree for something it didn't do.
 */
export function rendererReloadNotice(subject: string, reason: string): string {
  return reason === "killed"
    ? `${subject} was stopped from outside Daintree and was reloaded.`
    : `${subject} crashed and was automatically reloaded.`;
}
