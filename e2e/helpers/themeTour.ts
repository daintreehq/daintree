/**
 * Interactive theme-tour HUD.
 *
 * The sibling of `e2e/screenshots/theme-review.spec.ts`: that one writes PNGs
 * for asynchronous review, this one keeps the Electron window open and lets a
 * human walk the same surfaces live. Playwright drives the app into each scene;
 * a small control panel injected into the renderer is how the reviewer says
 * where to go next.
 *
 * The HUD is deliberately NOT themed. It renders inside a shadow root with its
 * own neutral grey palette so nothing it draws can be mistaken for the theme
 * under review, and so app CSS cannot leak in and change what the reviewer sees.
 *
 * Injected via `page.addInitScript`, so it survives the reload that
 * `setAppTheme` performs when the reviewer toggles between two themes.
 */

export interface TourSceneMeta {
  id: string;
  label: string;
  /** What the reviewer should actually be looking at in this scene. */
  note: string;
}

export interface TourState {
  themeId: string;
  compareId: string;
  activeThemeId: string;
  sceneIndex: number;
  scenes: TourSceneMeta[];
  status: string;
  busy: boolean;
}

export type TourCommand =
  | { kind: "goto"; index: number }
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "compare" }
  | { kind: "finish" };

declare global {
  interface Window {
    __tourCmd: TourCommand | null;
    __tourSetState?: (state: TourState) => void;
    __tourState?: TourState;
  }
}

/**
 * Runs in the renderer before app scripts on every navigation. Everything the
 * HUD needs is inside this one function — it is serialized to the page, so it
 * can close over nothing from this module.
 */
export function installTourHud(): void {
  window.__tourCmd = null;

  const ready = (fn: () => void) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  };

  ready(() => {
    if (document.getElementById("daintree-theme-tour")) return;

    const host = document.createElement("div");
    host.id = "daintree-theme-tour";
    host.style.cssText = "position:fixed;inset:auto 16px 16px auto;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    document.body.appendChild(host);

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .panel {
        width: 310px; background: #17181a; color: #d6d8dc;
        border: 1px solid #34373c; border-radius: 8px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.6); overflow: hidden;
        font-size: 11px; line-height: 1.45;
      }
      .hd {
        display: flex; align-items: center; gap: 8px; padding: 8px 10px;
        background: #1e2023; border-bottom: 1px solid #34373c; cursor: default;
      }
      .hd b { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #f0f2f5; }
      .hd .sp { margin-left: auto; }
      .icon {
        background: #2a2d31; border: 1px solid #3d4147; color: #d6d8dc;
        border-radius: 5px; width: 22px; height: 20px; cursor: pointer; font-size: 11px; line-height: 1;
      }
      .icon:hover { background: #35393e; }
      .body { padding: 9px 10px 10px; }
      .scenes { max-height: 232px; overflow-y: auto; margin: 0 -3px 8px; }
      .scene {
        display: flex; gap: 7px; align-items: baseline; width: 100%; text-align: left;
        background: transparent; border: 1px solid transparent; color: #a8adb5;
        padding: 3px 6px; border-radius: 5px; cursor: pointer; font-size: 11px;
      }
      .scene:hover { background: #232629; color: #e8eaee; }
      .scene[aria-current="true"] { background: #2c3a4d; border-color: #47607f; color: #eaf1fa; }
      .scene .n { color: #6d737c; min-width: 15px; font-variant-numeric: tabular-nums; }
      .scene[aria-current="true"] .n { color: #9fb6d0; }
      .note { color: #8d939c; margin: 0 0 9px; min-height: 30px; }
      .row { display: flex; gap: 6px; margin-bottom: 8px; }
      button.act {
        flex: 1; background: #2a2d31; border: 1px solid #3d4147; color: #e2e5e9;
        border-radius: 5px; padding: 5px 6px; cursor: pointer; font-size: 11px;
      }
      button.act:hover:not(:disabled) { background: #35393e; }
      button.act:disabled { opacity: .4; cursor: default; }
      button.cmp { background: #2c3a4d; border-color: #47607f; }
      button.fin { background: #40282a; border-color: #6d4044; }
      .budget { border-top: 1px solid #2b2e33; padding-top: 8px; }
      .budget h4 { margin: 0 0 5px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #7d838c; font-weight: 600; }
      .b { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
      .sw { width: 10px; height: 10px; border-radius: 2px; border: 1px solid #00000060; flex: none; }
      .b .k { color: #9aa0a8; }
      .b .v { margin-left: auto; font-variant-numeric: tabular-nums; color: #e2e5e9; }
      .verdict { margin-top: 6px; padding: 4px 6px; border-radius: 4px; font-size: 10px; text-align: center; }
      .ok { background: #1d3326; color: #8fe0a8; }
      .no { background: #3a2226; color: #f0a3ab; }
      .status { margin-top: 7px; color: #7d838c; font-size: 10px; min-height: 13px; }
      .status.busy { color: #d8c07a; }
      .collapsed .body { display: none; }
    `;
    root.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="hd">
        <b id="ttl">theme tour</b>
        <span class="sp"></span>
        <button class="icon" id="min" title="Collapse">–</button>
      </div>
      <div class="body">
        <div class="scenes" id="scenes"></div>
        <p class="note" id="note"></p>
        <div class="row">
          <button class="act" id="prev">← prev</button>
          <button class="act" id="next">next →</button>
        </div>
        <div class="row">
          <button class="act cmp" id="cmp">compare</button>
          <button class="act fin" id="fin">finish</button>
        </div>
        <div class="budget">
          <h4>contrast budget · vs panel</h4>
          <div id="bud"></div>
          <div class="verdict" id="verdict"></div>
        </div>
        <div class="status" id="status"></div>
      </div>
    `;
    root.appendChild(panel);

    const $ = (id: string) => root.getElementById(id) as HTMLElement;
    const send = (cmd: TourCommand) => {
      if (window.__tourState?.busy) return;
      window.__tourCmd = cmd;
    };

    $("min").addEventListener("click", () => panel.classList.toggle("collapsed"));
    $("prev").addEventListener("click", () => send({ kind: "prev" }));
    $("next").addEventListener("click", () => send({ kind: "next" }));
    $("cmp").addEventListener("click", () => send({ kind: "compare" }));
    $("fin").addEventListener("click", () => send({ kind: "finish" }));

    // ── contrast budget readout ──────────────────────────────────────────────
    // Reads the LIVE css vars rather than any authored value, so the panel
    // reports what is actually painted — including on the comparison theme,
    // where the budget property is expected NOT to hold.
    const lin = (c: number) => {
      const n = c / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    };
    // Resolve ANY css colour to real pixels. getComputedStyle is not enough:
    // Chromium can serialize a computed colour back as oklch()/oklab(), so a
    // string parser silently returns null for exactly the values this theme
    // authors — which is how twelve category colours got "added" to the scan
    // and then skipped. Painting one pixel and reading it back cannot miss.
    const probeCanvas = document.createElement("canvas");
    probeCanvas.width = 1;
    probeCanvas.height = 1;
    const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
    const paint = (value: string, sentinel: string): [number, number, number] => {
      probeCtx!.clearRect(0, 0, 1, 1);
      probeCtx!.fillStyle = sentinel;
      probeCtx!.fillStyle = value;
      probeCtx!.fillRect(0, 0, 1, 1);
      const d = probeCtx!.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    };
    const resolve = (value: string): [number, number, number] | null => {
      if (!probeCtx || !value || !value.trim()) return null;
      const v = value.trim();
      // A value the engine REJECTS leaves fillStyle at whatever it already was,
      // so a single sentinel would silently measure the sentinel. Paint twice
      // from two different sentinels: a value the engine accepts produces the
      // same pixel both times, a rejected one produces each sentinel back.
      const a = paint(v, "#000000");
      const b = paint(v, "#ffffff");
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return null;
      return a;
    };
    const lum = (value: string): number | null => {
      const rgb = resolve(value);
      if (!rgb) return null;
      const [r, g, b] = rgb.map(lin);
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    // Fail CLOSED: a token the readout could not measure is reported, never
    // silently dropped. A budget computed over an unknown subset is not a budget.
    const unresolved: string[] = [];
    const ratio = (a: string, b: string): number | null => {
      const x = lum(a);
      const y = lum(b);
      if (x === null || y === null) return null;
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    // A category paints BOTH ways: the base token is the panel-kind icon and is
    // also used as chip text on its own alpha tint, while `-text` is the
    // engineered label derivative. Both are scored, on different rules.
    const CATEGORY_NAMES = [
      "blue",
      "purple",
      "cyan",
      "green",
      "amber",
      "orange",
      "teal",
      "indigo",
      "rose",
      "pink",
      "violet",
      "slate",
    ];
    const cssVar = (name: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    // The CAPPED INDICATOR BAND: every semantic colour that is only ever a dot,
    // fill, rail or piece of chrome. `pr-*` and `state-modified` are in here
    // deliberately — they are inherited rather than authored, they render in
    // resting toolbar and sidebar chrome, and leaving them out is exactly how a
    // theme convinces itself it has a budget it does not have.
    const CAPPED = [
      "accent-primary",
      "accent-secondary",
      "status-success",
      "status-warning",
      "status-info",
      "activity-active",
      "activity-idle",
      "activity-working",
      "activity-completed",
      "pr-open",
      "pr-merged",
      "pr-closed",
      "pr-draft",
      "state-modified",
    ];
    // DUAL-USE: the category bases are panel-kind icons AND chip text, so they
    // are floored by AA rather than capped and are scored on their own row.
    // Folding them into the capped band would report a budget failure for a
    // tier the cap does not govern.
    const DUAL_USE = CATEGORY_NAMES.map((n) => `category-${n}`);
    // Search is a locator the user just asked for, not ambient state, so it is
    // scored as its own tier rather than folded into the quiet band — but it
    // still has to sit below both signals, so it is shown, not hidden.
    const LOCATOR = "search-highlight-text";

    function renderBudget() {
      const panelBg = cssVar("--theme-surface-panel");
      const rows: string[] = [];
      // Reset BEFORE the first measurement: the signals and the locator have to
      // be tracked too, or an unmeasurable search colour becomes 0 downstream
      // and quietly passes the ordering test.
      unresolved.length = 0;
      const line = (key: string, token: string) => {
        const hex = cssVar(`--theme-${token}`);
        const r = ratio(hex, panelBg);
        if (r === null) unresolved.push(key);
        rows.push(
          `<div class="b"><span class="sw" style="background:${hex}"></span>` +
            `<span class="k">${key}</span><span class="v">${r ? r.toFixed(2) : "—"}:1</span></div>`
        );
        return r;
      };
      const waiting = line("waiting", "activity-waiting");
      const danger = line("danger", "status-danger");
      const locator = line("search", LOCATOR);

      let loudest = 0;
      let loudestName = "";
      const consider = (name: string, value: string) => {
        const r = ratio(value, panelBg);
        if (r === null) {
          unresolved.push(name);
          return;
        }
        if (r > loudest) {
          loudest = r;
          loudestName = name;
        }
      };
      for (const token of CAPPED) {
        consider(token.replace(/^(status|activity|accent)-/, ""), cssVar(`--theme-${token}`));
      }
      // Dual-use bases: measured and shown, but scored against AA, not the cap.
      let loudestBase = 0;
      for (const token of DUAL_USE) {
        const r = ratio(cssVar(`--theme-${token}`), panelBg);
        if (r === null) {
          unresolved.push(token);
          continue;
        }
        if (r > loudestBase) loudestBase = r;
      }
      // Category is DUAL-USE — the same token is a panel-kind icon and chip text
      // — so it is floored by AA rather than capped, and scoring it against the
      // indicator band would report a failure for a colour the band does not
      // govern. It gets its own invariant instead: every label must stay below
      // `text-secondary`, so a coloured chip never outweighs the prose beside it.
      const secondaryRaw = ratio(cssVar("--theme-text-secondary"), panelBg);
      if (secondaryRaw === null) unresolved.push("text-secondary");
      const secondary = secondaryRaw ?? 0;
      let loudestLabel = 0;
      for (const n of CATEGORY_NAMES) {
        const value = cssVar(`--color-category-${n}-text`);
        const r = ratio(value, panelBg);
        if (r === null) {
          unresolved.push(`${n} label`);
          continue;
        }
        if (r > loudestLabel) loudestLabel = r;
      }
      rows.push(
        `<div class="b"><span class="sw" style="background:${cssVar("--color-category-blue-text")}"></span>` +
          `<span class="k">dual-use max<br>(base / label)</span>` +
          `<span class="v">${loudestBase.toFixed(2)} / ${loudestLabel.toFixed(2)}</span></div>`
      );
      rows.push(
        `<div class="b"><span class="sw" style="background:${cssVar("--theme-accent-primary")}"></span>` +
          `<span class="k">loudest quiet<br>(${loudestName})</span>` +
          `<span class="v">${loudest.toFixed(2)}:1</span></div>`
      );
      $("bud").innerHTML = rows.join("");

      const quieterSignal = Math.min(waiting ?? 0, danger ?? 0);
      const headroom = loudest > 0 ? quieterSignal / loudest : 0;
      // Three conditions. The signals must clear the INDICATOR band; nothing
      // outside that band may outrank them; and the dual-use category labels
      // must stay under `text-secondary`, which is the invariant standing in for
      // the cap on the tier the cap does not govern.
      const ordered =
        (locator ?? 0) < quieterSignal &&
        loudestLabel < quieterSignal &&
        loudestBase < quieterSignal;
      const labelsQuiet = loudestLabel > 0 && secondary > 0 && loudestLabel <= secondary;
      const holds = headroom >= 1.5 && ordered && labelsQuiet;
      const v = $("verdict");
      if (unresolved.length > 0) {
        v.className = "verdict no";
        v.textContent = `unmeasured: ${unresolved.slice(0, 3).join(", ")}${unresolved.length > 3 ? ` +${unresolved.length - 3}` : ""}`;
        return;
      }
      v.className = `verdict ${holds ? "ok" : "no"}`;
      v.textContent = !ordered
        ? `a non-signal outranks a signal`
        : !labelsQuiet
          ? `category labels (${loudestLabel.toFixed(2)}) exceed text-secondary (${secondary.toFixed(2)})`
          : holds
            ? `signals ${headroom.toFixed(2)}x the capped band (${loudestName})`
            : `no budget — signals only ${headroom.toFixed(2)}x`;
    }

    window.__tourSetState = (state: TourState) => {
      window.__tourState = state;
      $("ttl").textContent =
        `${state.activeThemeId} · scene ${state.sceneIndex + 1}/${state.scenes.length}`;
      $("scenes").innerHTML = state.scenes
        .map(
          (s, i) =>
            `<button class="scene" data-i="${i}" aria-current="${i === state.sceneIndex}">` +
            `<span class="n">${String(i + 1).padStart(2, "0")}</span><span>${s.label}</span></button>`
        )
        .join("");
      for (const el of Array.from($("scenes").querySelectorAll<HTMLElement>(".scene"))) {
        el.addEventListener("click", () =>
          send({ kind: "goto", index: Number(el.dataset.i ?? "0") })
        );
      }
      $("note").textContent = state.scenes[state.sceneIndex]?.note ?? "";
      $("cmp").textContent =
        state.activeThemeId === state.themeId
          ? `compare → ${state.compareId}`
          : `back → ${state.themeId}`;
      const status = $("status");
      status.textContent = state.status;
      status.className = `status${state.busy ? " busy" : ""}`;
      for (const id of ["prev", "next", "cmp", "fin"]) {
        ($(id) as HTMLButtonElement).disabled = state.busy;
      }
      renderBudget();
    };

    if (window.__tourState) window.__tourSetState(window.__tourState);
  });
}
