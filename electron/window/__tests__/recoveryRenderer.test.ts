// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const RENDERER_PATH = path.join(__dirname, "..", "..", "..", "public", "recovery-renderer.js");
const RENDERER_SOURCE = fs.readFileSync(RENDERER_PATH, "utf8");

/**
 * Loads `public/recovery-renderer.js` into the jsdom document with a given set
 * of URL params. The file is a vanilla IIFE that reads `window.location.search`
 * and mutates DOM elements by id — so we rebuild the relevant DOM from
 * `public/recovery.html`, rewrite `location.search`, and eval the IIFE.
 */
function renderWithParams(search: string, electronApi?: unknown): void {
  document.body.innerHTML = `
    <div class="container">
      <div class="project-chip" id="project-chip" style="display: none"></div>
      <h1 id="crash-title">Something went wrong</h1>
      <p class="description" id="crash-description">default</p>
      <p class="cta-hint" id="cta-hint" style="display: none"></p>
      <p class="backup-line" id="backup-line" style="display: none"></p>
      <div class="details" id="crash-details">Loading crash details…</div>
      <div class="actions">
        <button id="btn-reload">Reload window</button>
        <button id="btn-export-diagnostics">Export diagnostics</button>
        <button id="btn-open-logs">Open logs</button>
        <button id="btn-reset" aria-expanded="false" aria-controls="reset-confirm-section">
          Reset workspace state
        </button>
        <div id="reset-confirm-section" class="reset-confirm-section">
          <p class="reset-confirm-description" id="reset-confirm-description">
            This will clear all open sessions and reset sidebar and panel layout.
          </p>
          <p
            class="reset-confirm-detail"
            id="reset-confirm-detail"
            style="display: none"
          ></p>
          <button id="btn-reset-confirm">Reset workspace</button>
          <button id="btn-reset-cancel">Cancel</button>
        </div>
      </div>
      <div class="status" id="status" role="status" aria-live="polite"></div>
    </div>
  `;

  // jsdom does not support the `inert` HTML attribute via setAttribute alone; the
  // renderer uses setAttribute/removeAttribute directly, which we exercise in tests.
  document.getElementById("reset-confirm-section")?.setAttribute("inert", "");

  Object.defineProperty(window, "location", {
    value: { search },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(window, "electron", {
    value: electronApi,
    writable: true,
    configurable: true,
  });

  new Function(RENDERER_SOURCE)();
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? "";
}

function isVisible(id: string): boolean {
  return document.getElementById(id)?.style.display !== "none";
}

describe("recovery-renderer.js — reason to copy mapping", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("oom renders memory-specific copy and hint", () => {
    renderWithParams("?reason=oom&exitCode=137");
    expect(text("crash-title")).toBe("Out of memory");
    expect(text("crash-description")).toContain("ran out of memory");
    expect(isVisible("cta-hint")).toBe(true);
    expect(text("cta-hint")).toContain("close unused panels");
  });

  it("launch-failed renders reinstall hint", () => {
    renderWithParams("?reason=launch-failed&exitCode=1");
    expect(text("crash-title")).toContain("couldn't start");
    expect(isVisible("cta-hint")).toBe(true);
    expect(text("cta-hint")).toContain("reinstalling");
  });

  it("integrity-failure renders reinstall guidance", () => {
    renderWithParams("?reason=integrity-failure&exitCode=1");
    expect(text("crash-title")).toBe("Integrity check failed");
    expect(isVisible("cta-hint")).toBe(true);
    expect(text("cta-hint")).toContain("Reinstall");
  });

  it("killed renders terminated-externally copy (not 'Something went wrong')", () => {
    renderWithParams("?reason=killed&exitCode=137");
    expect(text("crash-title")).toBe("Window was terminated");
    expect(text("crash-title")).not.toBe("Something went wrong");
    expect(text("crash-description")).toContain("operating system");
    expect(isVisible("cta-hint")).toBe(false);
  });

  it("crashed renders generic crash copy", () => {
    renderWithParams("?reason=crashed&exitCode=1");
    expect(text("crash-title")).toBe("Something went wrong");
    expect(text("crash-description")).toContain("crashed repeatedly");
  });

  it("abnormal-exit renders abnormal-exit copy", () => {
    renderWithParams("?reason=abnormal-exit&exitCode=1");
    expect(text("crash-title")).toBe("Window exited unexpectedly");
  });

  it("unknown reason falls back to generic crashed copy", () => {
    renderWithParams("?reason=some-future-reason&exitCode=1");
    expect(text("crash-title")).toBe("Something went wrong");
  });

  it("renders raw reason and exitCode in the details block", () => {
    renderWithParams("?reason=oom&exitCode=137");
    expect(text("crash-details")).toContain("Reason: oom");
    expect(text("crash-details")).toContain("Exit code: 137");
  });
});

describe("recovery-renderer.js — project chip", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders project name when param is present", () => {
    renderWithParams("?reason=crashed&exitCode=1&project=my-project");
    expect(isVisible("project-chip")).toBe(true);
    expect(text("project-chip")).toBe("my-project");
  });

  it("hides project chip when param is absent", () => {
    renderWithParams("?reason=crashed&exitCode=1");
    expect(isVisible("project-chip")).toBe(false);
  });

  it("hides project chip when param is empty string", () => {
    renderWithParams("?reason=crashed&exitCode=1&project=");
    expect(isVisible("project-chip")).toBe(false);
  });
});

describe("recovery-renderer.js — backup line", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders backup line for a valid timestamp", () => {
    const ts = 1_700_000_000_000;
    renderWithParams(`?reason=crashed&exitCode=1&backupTimestamp=${ts}`);
    expect(isVisible("backup-line")).toBe(true);
    expect(text("backup-line")).toContain("workspace backup is available from");
  });

  it("hides backup line when param is absent", () => {
    renderWithParams("?reason=crashed&exitCode=1");
    expect(isVisible("backup-line")).toBe(false);
  });

  it("hides backup line for zero timestamp", () => {
    renderWithParams("?reason=crashed&exitCode=1&backupTimestamp=0");
    expect(isVisible("backup-line")).toBe(false);
  });

  it("hides backup line for negative timestamp", () => {
    renderWithParams("?reason=crashed&exitCode=1&backupTimestamp=-1");
    expect(isVisible("backup-line")).toBe(false);
  });

  it("hides backup line for NaN", () => {
    renderWithParams("?reason=crashed&exitCode=1&backupTimestamp=NaN");
    expect(isVisible("backup-line")).toBe(false);
  });

  it("hides backup line for Infinity", () => {
    renderWithParams("?reason=crashed&exitCode=1&backupTimestamp=Infinity");
    expect(isVisible("backup-line")).toBe(false);
  });

  it("hides backup line for timestamp beyond ECMAScript Date max", () => {
    // 8.64e15 is the maximum valid Date; 1e18 is finite and positive but
    // produces "Invalid Date" when formatted.
    renderWithParams("?reason=crashed&exitCode=1&backupTimestamp=1000000000000000000");
    expect(isVisible("backup-line")).toBe(false);
  });
});

describe("recovery-renderer.js — reset confirm disclosure", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function makeApi() {
    return {
      recovery: {
        reloadApp: vi.fn(),
        resetAndReload: vi.fn(),
        exportDiagnostics: vi.fn(() => Promise.resolve(true)),
        openLogs: vi.fn(() => Promise.resolve()),
      },
    };
  }

  it("first click on Reset workspace state does not invoke resetAndReload IPC", () => {
    const api = makeApi();
    renderWithParams("?reason=crashed&exitCode=1", api);

    const trigger = document.getElementById("btn-reset") as HTMLButtonElement;
    trigger.click();

    expect(api.recovery.resetAndReload).not.toHaveBeenCalled();
  });

  it("first click expands the confirm section and toggles aria-expanded + inert", () => {
    const api = makeApi();
    renderWithParams("?reason=crashed&exitCode=1", api);

    const trigger = document.getElementById("btn-reset") as HTMLButtonElement;
    const section = document.getElementById("reset-confirm-section") as HTMLDivElement;

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(section.hasAttribute("inert")).toBe(true);
    expect(section.classList.contains("open")).toBe(false);

    trigger.click();

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(section.hasAttribute("inert")).toBe(false);
    expect(section.classList.contains("open")).toBe(true);
  });

  it("Cancel button collapses the section and restores focus to the trigger", () => {
    const api = makeApi();
    renderWithParams("?reason=crashed&exitCode=1", api);

    const trigger = document.getElementById("btn-reset") as HTMLButtonElement;
    const section = document.getElementById("reset-confirm-section") as HTMLDivElement;
    const cancel = document.getElementById("btn-reset-cancel") as HTMLButtonElement;

    trigger.click();
    expect(section.classList.contains("open")).toBe(true);

    cancel.click();

    expect(section.classList.contains("open")).toBe(false);
    expect(section.hasAttribute("inert")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("Reset workspace inside the confirm fires resetAndReload exactly once", () => {
    const api = makeApi();
    renderWithParams("?reason=crashed&exitCode=1", api);

    const trigger = document.getElementById("btn-reset") as HTMLButtonElement;
    const confirm = document.getElementById("btn-reset-confirm") as HTMLButtonElement;

    trigger.click();
    confirm.click();

    expect(api.recovery.resetAndReload).toHaveBeenCalledTimes(1);
  });

  it("Reset workspace status drops 'successfully' — shows 'Resetting workspace…'", () => {
    const api = makeApi();
    renderWithParams("?reason=crashed&exitCode=1", api);

    (document.getElementById("btn-reset") as HTMLButtonElement).click();
    (document.getElementById("btn-reset-confirm") as HTMLButtonElement).click();

    expect(text("status")).toBe("Resetting workspace…");
  });

  it("disables all action buttons while reset is in flight", () => {
    const api = makeApi();
    renderWithParams("?reason=crashed&exitCode=1", api);

    (document.getElementById("btn-reset") as HTMLButtonElement).click();
    (document.getElementById("btn-reset-confirm") as HTMLButtonElement).click();

    const ids = [
      "btn-reload",
      "btn-reset",
      "btn-export-diagnostics",
      "btn-open-logs",
      "btn-reset-confirm",
      "btn-reset-cancel",
    ];
    for (const id of ids) {
      expect((document.getElementById(id) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("renders panel count in the preview when panelCount param is valid and > 0", () => {
    renderWithParams("?reason=crashed&exitCode=1&panelCount=3", makeApi());
    (document.getElementById("btn-reset") as HTMLButtonElement).click();
    expect(text("reset-confirm-description")).toContain("3 open sessions");
  });

  it("uses singular 'session' for panelCount=1", () => {
    renderWithParams("?reason=crashed&exitCode=1&panelCount=1", makeApi());
    (document.getElementById("btn-reset") as HTMLButtonElement).click();
    expect(text("reset-confirm-description")).toContain("1 open session ");
    expect(text("reset-confirm-description")).not.toContain("1 open sessions");
  });

  it("omits the panel count line when panelCount is 0", () => {
    renderWithParams("?reason=crashed&exitCode=1&panelCount=0", makeApi());
    (document.getElementById("btn-reset") as HTMLButtonElement).click();
    expect(text("reset-confirm-description")).not.toContain("You have");
    expect(text("reset-confirm-description")).not.toContain("won't be recoverable");
  });

  it("omits the panel count line when panelCount is absent", () => {
    renderWithParams("?reason=crashed&exitCode=1", makeApi());
    (document.getElementById("btn-reset") as HTMLButtonElement).click();
    expect(text("reset-confirm-description")).not.toContain("You have");
    expect(text("reset-confirm-description")).not.toContain("won't be recoverable");
  });

  it("omits the panel count line for invalid panelCount values", () => {
    for (const bad of ["abc", "-1", "1.5", "NaN", "Infinity"]) {
      renderWithParams(`?reason=crashed&exitCode=1&panelCount=${bad}`, makeApi());
      (document.getElementById("btn-reset") as HTMLButtonElement).click();
      expect(text("reset-confirm-description")).not.toContain("You have");
      expect(text("reset-confirm-description")).not.toContain("won't be recoverable");
    }
  });

  it("shows backup detail line in confirm preview when backupTimestamp is valid", () => {
    const ts = 1_700_000_000_000;
    renderWithParams(`?reason=crashed&exitCode=1&backupTimestamp=${ts}`, makeApi());
    (document.getElementById("btn-reset") as HTMLButtonElement).click();
    expect(isVisible("reset-confirm-detail")).toBe(true);
    expect(text("reset-confirm-detail")).toContain("workspace backup from");
    expect(text("reset-confirm-detail")).toContain("won't auto-restore");
  });

  it("hides backup detail line in confirm preview when backupTimestamp is absent", () => {
    renderWithParams("?reason=crashed&exitCode=1", makeApi());
    (document.getElementById("btn-reset") as HTMLButtonElement).click();
    expect(isVisible("reset-confirm-detail")).toBe(false);
  });

  it("renders all four button labels in sentence case", () => {
    renderWithParams("?reason=crashed&exitCode=1", makeApi());
    expect(text("btn-reload").trim()).toBe("Reload window");
    expect(text("btn-export-diagnostics").trim()).toBe("Export diagnostics");
    expect(text("btn-open-logs").trim()).toBe("Open logs");
    expect(text("btn-reset").trim()).toBe("Reset workspace state");
  });

  it("Export diagnostics success status drops 'successfully' — shows 'Diagnostics saved'", async () => {
    const api = makeApi();
    renderWithParams("?reason=crashed&exitCode=1", api);

    (document.getElementById("btn-export-diagnostics") as HTMLButtonElement).click();
    // Drain microtasks until status updates (then + finally chain).
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(text("status")).toBe("Diagnostics saved");
  });

  it("Open logs success status drops 'successfully' — shows 'Logs opened'", async () => {
    const api = makeApi();
    renderWithParams("?reason=crashed&exitCode=1", api);

    (document.getElementById("btn-open-logs") as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(text("status")).toBe("Logs opened");
  });
});
