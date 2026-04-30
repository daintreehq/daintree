// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
function renderWithParams(search: string): void {
  document.body.innerHTML = `
    <div class="container">
      <div class="project-chip" id="project-chip" style="display: none"></div>
      <h1 id="crash-title">Something went wrong</h1>
      <p class="description" id="crash-description">default</p>
      <p class="cta-hint" id="cta-hint" style="display: none"></p>
      <p class="backup-line" id="backup-line" style="display: none"></p>
      <div class="details" id="crash-details">Loading crash details…</div>
      <button id="btn-reload">Reload Window</button>
      <button id="btn-reset">Reset Workspace State</button>
    </div>
  `;

  Object.defineProperty(window, "location", {
    value: { search },
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
