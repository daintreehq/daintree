/**
 * The bare minimum of Electron this harness needs to mount the panel chrome in a browser.
 *
 * ## Why there is a shim at all
 *
 * The header and the strip are the product's own components, not copies — which is the
 * point, because a copy drifts. The cost is that what they pull in reaches for things a
 * browser tab does not have, chiefly `window.electron`. Without a stand-in the harness
 * renders nothing, which is the worst way for a visual-review tool to fail: it looks
 * like the panel, and it is a blank page.
 *
 * ## Why a Proxy rather than a hand-written mock
 *
 * `window.electron` is ~75 namespaces of methods that return either a Promise or a
 * cleanup function. Hand-writing the subset these components happen to use today would
 * break the next time they use one more, and the failure would again be a blank harness
 * rather than an error anyone reads. A Proxy answers every name the same way — a
 * function that resolves to `undefined` and doubles as its own unsubscribe — so the
 * harness degrades to "nothing happened" instead of "nothing rendered".
 *
 * This is a HARNESS shim and nothing else imports it. It is deliberately not a general
 * test double.
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
  // this file could contain.
  if (Reflect.get(window, "electron")) return;
  Reflect.set(window, "electron", new Proxy({}, { get: () => namespace() }));
}
