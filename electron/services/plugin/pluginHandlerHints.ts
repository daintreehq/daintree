/**
 * The first mistake every plugin author makes is reading the payload from the
 * wrong parameter, and the two registration APIs disagree in opposite
 * directions:
 *
 * - `host.registerHandler(channel, fn)` calls `fn(ctx, payload)`. A handler
 *   written as `(payload) => …` is handed the IPC context instead, so every
 *   field it reads is missing.
 * - `host.registerAction(descriptor, fn)` calls `fn(args)` and passes no
 *   context at all. A handler written as `(ctx, args) => …` gets the payload in
 *   the first parameter and `undefined` in the second.
 *
 * Both produce the same unhelpful `Cannot read properties of undefined` from
 * inside the plugin's own code, where nothing names the cause. Declared arity
 * is the signal: it is the one thing the host can observe about a closure it
 * did not write, and in both cases the wrong arity is what the mistake *is*.
 *
 * A hint, never a behaviour change — the original error is still what
 * propagates, with a sentence appended.
 */

const HINT_MARKER = "Daintree hint:";

function isPropertyOfUndefined(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const message = error.message;
  return (
    // `\b.*\b` rather than a literal space on both sides: V8's own message is
    // "Cannot read properties of undefined (reading 'x')" — one space, not two —
    // and requiring the second matched nothing it was written for.
    /Cannot read propert(?:y|ies)\b.*\bof undefined/.test(message) ||
    /Cannot destructure .* of 'undefined'/.test(message) ||
    /undefined is not an object/.test(message)
  );
}

/**
 * The hint an action handler earns, or null. `run(args)` is the whole contract,
 * so a second declared parameter is always `undefined` and reading through it
 * always throws.
 */
export function actionHandlerArityHint(handler: unknown, error: unknown): string | null {
  if (typeof handler !== "function" || handler.length < 2) return null;
  if (!isPropertyOfUndefined(error)) return null;
  return `${HINT_MARKER} an action handler is called with the arguments object as its only parameter — there is no context parameter, so a handler declaring a second one always receives undefined. Read the payload from the first parameter.`;
}

/**
 * The hint a channel handler earns, or null. `handler(ctx, payload)` is the
 * contract, so a single declared parameter is the IPC context — `projectId`,
 * `worktreeId`, `webContentsId`, `pluginId` — and not the payload the caller
 * sent.
 */
export function channelHandlerArityHint(handler: unknown, error: unknown): string | null {
  if (typeof handler !== "function" || handler.length !== 1) return null;
  if (!isPropertyOfUndefined(error)) return null;
  return `${HINT_MARKER} a channel handler is called with the IPC context first and the payload second, so a handler declaring one parameter is reading the context. Write it as (ctx, payload) and read the payload from the second parameter.`;
}

/**
 * Append a hint to an error's own message, in place, so the stack and the error
 * type both survive and the audit trail records the hint alongside the failure.
 * Idempotent: a handler that throws a shared error object won't accumulate
 * copies across dispatches.
 */
export function appendHandlerHint(error: unknown, hint: string | null): void {
  if (hint === null || !(error instanceof Error)) return;
  if (error.message.includes(HINT_MARKER)) return;
  error.message = `${error.message}\n\n${hint}`;
}
