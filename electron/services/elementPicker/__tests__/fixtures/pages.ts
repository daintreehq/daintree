/// <reference lib="dom" />
/**
 * Pages that give the picker nothing to read beyond the DOM, built the way
 * each runtime leaves them rather than by running the framework: the markers
 * and attributes below are what Solid 1.9, solid-devtools and Lit put into a
 * page, and nothing else is. Each mount returns its own cleanup, since the
 * globals it sets outlive `document.body`.
 */

const scope = globalThis as unknown as Record<string, unknown>;

export interface MountedPage {
  /** The element a test points at first. */
  target: Element;
  cleanup(): void;
}

/** A global's value, or a getter for one; what was there before comes back on cleanup. */
type Global = { value: unknown } | { get(): unknown };

function setGlobals(globals: Record<string, Global>): () => void {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, global] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(scope, name));
    Object.defineProperty(scope, name, {
      configurable: true,
      enumerable: true,
      ...("get" in global ? { get: global.get } : { value: global.value, writable: true }),
    });
  }
  return () => {
    for (const [name, prior] of previous) {
      if (prior === undefined) delete scope[name];
      else Object.defineProperty(scope, name, prior);
    }
  };
}

export function mountStaticPage(): MountedPage {
  document.body.innerHTML = `
    <header><nav><a href="/docs?token=secret" class="nav-link">Docs</a></nav></header>
    <main id="content">
      <h1 class="title">Plain page</h1>
      <p class="lede">Nothing here but markup.</p>
      <button type="button" class="cta primary">Get started</button>
    </main>`;
  return { target: document.querySelector("button.cta")!, cleanup: () => undefined };
}

/**
 * Solid 1.9's stock dev build. Client-rendered, it leaves only the dev-only
 * `Solid$$` guard and the delegated-event expandos its JSX compiles to;
 * server-rendered, the hydration script's `_$HY` and `data-hk` keys too. No
 * component name, boundary or source reaches the DOM either way.
 * `devtools` adds what solid-devtools does when the user installed it with its
 * locator on: the debugger's global, which the picker must never call, and a
 * `data-source-loc` on every element the transform saw.
 */
export function mountSolidPage(
  options: { hydrated?: boolean; devtools?: boolean } = {}
): MountedPage & { debuggerTouches(): number } {
  const hk = (key: string) => (options.hydrated ? ` data-hk="${key}"` : "");
  const loc = (at: string) => (options.devtools ? ` data-source-loc="src/${at}"` : "");
  document.body.innerHTML = `
    <div id="root">
      <div class="app"${hk("0")}${loc("App.tsx:8:4")}>
        <h1${hk("00")}${loc("App.tsx:9:6")}>Counter</h1>
        <button type="button" class="increment"${hk("01")}${loc("components/Counter.tsx:14:8")}>Count: 0</button>
      </div>
    </div>`;
  const button = document.querySelector("button.increment")!;
  (button as unknown as Record<string, unknown>).$$click = () => undefined;
  const globals: Record<string, Global> = { Solid$$: { value: true } };
  if (options.hydrated) {
    globals._$HY = { value: { events: [], completed: new WeakSet(), r: {} } };
  }
  // Every read of the debugger's global and every trap on what it holds is
  // counted, so a reader that touched it and swallowed the error still shows.
  let touches = 0;
  if (options.devtools) {
    const touch = () => {
      touches += 1;
      throw new Error("the picker reached into solid-devtools");
    };
    const debuggerApi = new Proxy(
      {},
      { get: touch, has: touch, ownKeys: touch, getOwnPropertyDescriptor: touch, set: touch }
    );
    globals.SolidDevtools$$ = {
      get: () => {
        touches += 1;
        return debuggerApi;
      },
    };
  }
  return { target: button, cleanup: setGlobals(globals), debuggerTouches: () => touches };
}

const LIT_CARD = "fixture-lit-card";

/**
 * A Lit 3 element as it renders: an open shadow root with Lit's part markers
 * and a slot for its light-DOM content. The class is anonymous on purpose — a
 * minified build renames it, so nothing about it may reach an observation.
 */
export function defineLitCard(): string {
  if (customElements.get(LIT_CARD) === undefined) {
    customElements.define(
      LIT_CARD,
      class extends HTMLElement {
        constructor() {
          super();
          const root = this.attachShadow({ mode: "open" });
          root.innerHTML =
            '<!--?lit$1234567890$--><article class="card"><h2 class="heading">Title</h2>' +
            '<div class="body"><slot></slot></div><button class="action">Open</button></article>';
        }
      }
    );
  }
  return LIT_CARD;
}

/**
 * The Lit element on a page of its own, with the content it projects and the
 * version arrays Lit's packages push onto `globalThis`.
 */
export function mountLitPage(): MountedPage {
  defineLitCard();
  document.body.innerHTML = `
    <main id="app">
      <${LIT_CARD} id="hero"><p class="projected">Slotted copy</p></${LIT_CARD}>
    </main>`;
  const host = document.getElementById("hero")!;
  return {
    target: host.shadowRoot!.querySelector("button.action")!,
    cleanup: setGlobals({
      litElementVersions: { value: ["4.2.0"] },
      litHtmlVersions: { value: ["3.3.0"] },
      reactiveElementVersions: { value: ["2.1.0"] },
    }),
  };
}

export const LIT_CARD_TAG = LIT_CARD;
