import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yauzl from "yauzl";
import {
  collectBundleManifests,
  collectBundleMembers,
  parseLogEntries,
  writeBundleZip,
  type BundleDirs,
} from "../diagnosticsBundle.js";

const COLLECTED_AT = Date.parse("2026-10-31T08:00:00.000Z");
const WINDOW_START = COLLECTED_AT - 30 * 60 * 1000;
const OLD = "2026-10-30T08:00:00.000Z";
const RECENT = "2026-10-31T07:58:00.000Z";
const AFTER_REVIEW = "2026-10-31T08:01:00.000Z";

function readZip(zipPath: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) return reject(openErr);
      const entries = new Map<string, string>();
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr);
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

describe("diagnosticsBundle", () => {
  let root: string;
  let dirs: BundleDirs;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-bundle-"));
    const logDir = path.join(root, "logs");
    const crashesDir = path.join(root, "crashes");
    await fs.mkdir(logDir);
    await fs.mkdir(crashesDir);
    dirs = { logDir, logFile: path.join(logDir, "daintree.log"), crashesDir };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const writeLog = (name: string, content: string) =>
    fs.writeFile(path.join(dirs.logDir, name), content, "utf8");
  const writeCrash = (name: string, record: Record<string, unknown>) =>
    fs.writeFile(path.join(dirs.crashesDir!, name), JSON.stringify(record), "utf8");

  async function saveZip(bounds: { startMs: number | null; endMs: number | null }) {
    const zipPath = path.join(root, "bundle.zip");
    await writeBundleZip(zipPath, "{}", await collectBundleMembers(dirs, bounds, []));
    return readZip(zipPath);
  }

  it("lists a rotated log for review and scrubs the home path from the saved active log", async () => {
    const marker = "ROTATED-ONLY-MARKER-7f3a";
    const home = os.homedir();
    await writeLog(
      "daintree.log",
      `[${RECENT}] [WARN] Failed to get commit count {"cwd":"${home}/work/app"}\n` +
        `[${RECENT}] [INFO] opened /Users/alice/Private Client/notes.md\n`
    );
    await writeLog("daintree.log.1", `[${OLD}] [INFO] ${marker}\n`);

    const manifests = await collectBundleManifests(
      dirs,
      [
        { id: "30m", startMs: WINDOW_START },
        { id: "full", startMs: null },
      ],
      COLLECTED_AT
    );
    const rotated = manifests.full?.find((m) => m.name === "daintree.log.1");
    expect(rotated?.bytes).toBe(Buffer.byteLength(`[${OLD}] [INFO] ${marker}\n`));
    expect(manifests["30m"]?.map((m) => m.name)).toEqual(["daintree.log"]);

    const zip = await saveZip({ startMs: null, endMs: COLLECTED_AT });
    expect([...zip.keys()].sort()).toEqual(
      ["diagnostics.json", ...(manifests.full ?? []).map((m) => m.name)].sort()
    );
    expect(zip.get("daintree.log.1")).toContain(marker);
    const active = zip.get("daintree.log") ?? "";
    expect(active).not.toContain(home);
    expect(active).toContain(`"cwd":"~/work/app"`);
    expect(active).toContain("/Users/USER/Private Client/notes.md");
    expect(active).not.toContain("alice");
  });

  it("holds every log file to a short window and flags the latest crash it keeps anyway", async () => {
    await writeLog(
      "daintree.log",
      `[${OLD}] [ERROR] old failure\n    at stale (/app/old.js:1:1)\n` +
        `[${RECENT}] [INFO] recent line\n` +
        `[${AFTER_REVIEW}] [INFO] written while reviewing\n`
    );
    // Freshly touched, but every line in it is old: the lines decide, not mtime.
    await writeLog("daintree.log.1", `[${OLD}] [INFO] rotated old line\n`);
    await writeLog(
      "pty-host.log",
      `[${OLD}] [START] pid=1\n` +
        `============================================================\n` +
        `[${OLD}] [FATAL_INIT] pid=1 uptimeMs=5\n` +
        `error={"message":"old fatal"}\n\n` +
        `[${RECENT}] [START] pid=2\n`
    );
    await writeCrash("crash-old-a.json", { timestamp: Date.parse(OLD), errorMessage: "old crash" });
    await writeCrash("renderer-gone-old-b.json", { timestamp: Date.parse(OLD) + 1 });

    const manifests = await collectBundleManifests(
      dirs,
      [{ id: "30m", startMs: WINDOW_START }],
      COLLECTED_AT
    );
    expect(manifests["30m"]).toEqual([
      { name: "daintree.log", bytes: expect.any(Number) },
      { name: "pty-host.log", bytes: expect.any(Number) },
      { name: "crashes/crash-old-a.json", bytes: expect.any(Number), outsideWindow: true },
    ]);

    const zip = await saveZip({ startMs: WINDOW_START, endMs: COLLECTED_AT });
    expect([...zip.keys()]).toEqual([
      "diagnostics.json",
      "daintree.log",
      "pty-host.log",
      "crashes/crash-old-a.json",
    ]);
    expect(zip.get("daintree.log")).toBe(`[${RECENT}] [INFO] recent line\n`);
    expect(zip.get("pty-host.log")).toBe(`[${RECENT}] [START] pid=2\n`);
    // Nothing here needs scrubbing, so the listed sizes are the saved sizes.
    for (const member of manifests["30m"] ?? []) {
      expect(Buffer.byteLength(zip.get(member.name) ?? "")).toBe(member.bytes);
    }
  });

  it("leaves out crash records dated after the review, even as the newest fatal crash", async () => {
    await writeCrash("crash-old-a.json", { timestamp: Date.parse(OLD) });
    await writeCrash("crash-late-b.json", { timestamp: Date.parse(AFTER_REVIEW) });

    const zip = await saveZip({ startMs: WINDOW_START, endMs: COLLECTED_AT });
    expect([...zip.keys()]).toEqual(["diagnostics.json", "crashes/crash-old-a.json"]);
  });

  it("scrubs paths a line at a time so a path never swallows the lines after it", async () => {
    await writeLog(
      "daintree.log",
      `[${RECENT}] [WARN] cwd=/Users/alice\n[${RECENT}] [INFO] next entry survives\n`
    );

    const zip = await saveZip({ startMs: null, endMs: null });
    expect(zip.get("daintree.log")).toBe(
      `[${RECENT}] [WARN] cwd=/Users/USER\n[${RECENT}] [INFO] next entry survives\n`
    );
  });

  it("applies the user's rules after the automatic scrubbing", async () => {
    await writeLog("daintree.log", `[${RECENT}] [INFO] project acme-secret-plan opened\n`);

    const [member] = await collectBundleMembers(dirs, { startMs: null, endMs: null }, [
      { find: "acme-secret-plan", replace: "[REDACTED]" },
    ]);
    expect(member).toEqual({
      name: "daintree.log",
      content: `[${RECENT}] [INFO] project [REDACTED] opened\n`,
    });
  });
});

describe("parseLogEntries", () => {
  it("keeps continuation lines, CRLF endings and a leading fragment with their entries", () => {
    const entries = parseLogEntries(
      `tail of an older entry\r\n[${OLD}] [ERROR] boom\r\n  at x\r\n[${RECENT}] [INFO] ok`
    );
    expect(entries).toEqual([
      { timestamp: null, text: "tail of an older entry\r\n" },
      { timestamp: Date.parse(OLD), text: `[${OLD}] [ERROR] boom\r\n  at x\r\n` },
      { timestamp: Date.parse(RECENT), text: `[${RECENT}] [INFO] ok` },
    ]);
  });

  it("opens an entry at the rule above a dated header, and only there", () => {
    const entries = parseLogEntries(
      `[${OLD}] [START] pid=1\n====\n[${RECENT}] [FATAL] pid=1\n====\n`
    );
    expect(entries).toEqual([
      { timestamp: Date.parse(OLD), text: `[${OLD}] [START] pid=1\n` },
      { timestamp: Date.parse(RECENT), text: `====\n[${RECENT}] [FATAL] pid=1\n====\n` },
    ]);
  });

  it("treats a stamp without a time zone as undated rather than local time", () => {
    const entries = parseLogEntries(`[${OLD}] [INFO] a\n[2026-10-31T07:58:00.000] [INFO] b\n`);
    expect(entries).toEqual([
      {
        timestamp: Date.parse(OLD),
        text: `[${OLD}] [INFO] a\n[2026-10-31T07:58:00.000] [INFO] b\n`,
      },
    ]);
  });
});
