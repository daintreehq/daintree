// xterm's core plus the addons every terminal builds (fit, serialize, web
// links) load on first terminal creation rather than at boot, so a project view
// with no terminals never parses or compiles them (#14239). Every construction
// site already sits behind an await (getOrCreate, rebuild, setupTerminalAddons);
// code that runs only once a terminal exists reads the cached modules
// synchronously through getLoadedXtermCore().
//
// The stylesheet rides along: it is unlayered, so it outranks the app's
// `@layer base` overrides whatever order it is injected in.

interface XtermCore {
  Terminal: (typeof import("@xterm/xterm"))["Terminal"];
  FitAddon: (typeof import("@xterm/addon-fit"))["FitAddon"];
  SerializeAddon: (typeof import("@xterm/addon-serialize"))["SerializeAddon"];
  WebLinksAddon: (typeof import("@xterm/addon-web-links"))["WebLinksAddon"];
}

let loaded: XtermCore | null = null;
let loadPromise: Promise<XtermCore> | null = null;

export function loadXtermCore(): Promise<XtermCore> {
  if (loaded) return Promise.resolve(loaded);
  if (loadPromise) return loadPromise;
  loadPromise = Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-serialize"),
    import("@xterm/addon-web-links"),
    import("@xterm/xterm/css/xterm.css"),
  ])
    .then(([xterm, fit, serialize, webLinks]) => {
      loaded = {
        Terminal: xterm.Terminal,
        FitAddon: fit.FitAddon,
        SerializeAddon: serialize.SerializeAddon,
        WebLinksAddon: webLinks.WebLinksAddon,
      };
      return loaded;
    })
    .catch((err: unknown) => {
      loadPromise = null;
      throw err;
    });
  return loadPromise;
}

export function getLoadedXtermCore(): XtermCore {
  if (!loaded) throw new Error("xterm core used before loadXtermCore() resolved");
  return loaded;
}

export const __testing = {
  reset(): void {
    loaded = null;
    loadPromise = null;
  },
};
