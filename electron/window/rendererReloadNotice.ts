/**
 * Toast copy for a renderer that died and was reloaded. A `killed` renderer
 * Daintree didn't terminate itself was signalled from outside (a stray
 * `pkill`), so calling it a crash would point users and bug reports at
 * Daintree for something it didn't do.
 */
export function rendererReloadNotice(
  subject: string,
  reason: string,
  intent: string | null = null
): string {
  if (reason === "killed") {
    return intent
      ? `${subject} was restarted.`
      : `${subject} was stopped from outside Daintree and was reloaded.`;
  }
  return `${subject} crashed and was automatically reloaded.`;
}
