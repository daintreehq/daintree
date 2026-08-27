/**
 * The bare minimum of Electron this harness needs to mount the panel in a browser.
 *
 * ## Why there is a shim at all
 *
 * The panel's composer is the terminal's OWN input bar, not a copy of it — which is the
 * point, because a copy drifts. The cost is that the bar reaches for things a browser
 * tab does not have: `window.electron`, and a `WorktreeStoreProvider` above it. When the
 * composer became the real bar, this harness stopped rendering entirely and every
 * fixture threw `useWorktreeStore must be used within WorktreeStoreProvider` — a design
 * review tool that silently reviews a blank page.
 *
 * ## Why a Proxy rather than a hand-written mock
 *
 * `window.electron` is ~75 namespaces of methods that return either a Promise or a
 * cleanup function. Hand-writing the subset the bar happens to use today would break the
 * next time it uses one more, and the failure would again be a blank harness rather than
 * an error anyone reads. A Proxy answers every name the same way — a function that
 * resolves to `undefined` and doubles as its own unsubscribe — so the harness degrades
 * to "nothing happened" instead of "nothing rendered".
 *
 * This is a HARNESS shim and nothing else imports it. It is deliberately not a general
 * test double: a fixture that needed real IPC answers would be reviewing the wrong
 * thing, because these states were captured from a real engine precisely so the panel
 * would not have to be driven live to be looked at.
 */

/**
 * What every shimmed method returns: a value that is BOTH awaitable and callable.
 *
 * The bridge has two return shapes — a Promise for a request, a cleanup function for a
 * subscription — and the shim does not know which name is which. A thenable function
 * satisfies both: `await it` resolves to `undefined`, and `it()` is a safe no-op. A
 * plain Promise fails the second (`cleanup is not a function`, in every effect teardown
 * at once) and a plain function fails the first.
 */
function inert(): unknown {
  const settled = Promise.resolve(undefined);
  const fn = () => undefined;
  // The WHOLE promise surface, not just `then`. Callers reach for `.catch` on a
  // fire-and-forget read as readily as they await it, and a shim that covers one of the
  // two fails the harness in exactly the way it was written to stop.
  //
  // Returned as `unknown` rather than asserted into an intersection of a function and a
  // Promise. It is genuinely neither — it is a duck that answers to both — and writing
  // an assertion here would state a type the value does not have, in the one file whose
  // whole job is to be untyped scaffolding. Nothing reads the type: it leaves through a
  // Proxy typed `unknown`.
  return Object.assign(fn, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

function namespace(): unknown {
  return new Proxy({}, { get: () => () => inert() });
}

/**
 * Installs the shim if nothing real is present. Idempotent, and it never overwrites a
 * genuine bridge — the harness is served by Vite today and could be opened inside the
 * app tomorrow, where the real one must win.
 */
export function installPreviewShims(): void {
  // Reflect rather than an assertion. `window.electron` is globally declared with the
  // real bridge's type (src/types/electron.d.ts), so assigning a Proxy to it needs a
  // cast that claims this scaffolding IS that bridge — the single most misleading line
  // this file could contain, in the file most likely to be read by someone wondering
  // why the harness behaves oddly.
  if (Reflect.get(window, "electron")) return;
  Reflect.set(window, "electron", new Proxy({}, { get: () => namespace() }));
}
