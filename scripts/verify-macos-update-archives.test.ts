import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

// The gate itself only runs on a macOS release runner, but its orchestration —
// which archives get audited, what happens when one fails, whether extraction
// dirs are reaped — is plain shell and must be provable on the Ubuntu unit-test
// runner. Every macOS tool it shells out to is stubbed on PATH.
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "daintree-update-archives-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

type Harness = {
  binDir: string;
  releaseDir: string;
  destinationsLog: string;
  dittoLog: string;
  codesignLog: string;
  archives: string[];
};

// The command the gate exists to run. A stub that ignored arguments would let a
// regression drop `--deep`/`--strict` — or the whole call — and still pass.
const DIRECT_VERIFY_FLAGS = ["--verify", "--deep", "--strict"];

/**
 * Build a fake release directory plus PATH stubs.
 *
 * `ditto` is stubbed to materialize an .app skeleton — including the two spawned
 * helpers verify-helper-entitlements.sh insists on — into whatever destination
 * the script chose, and to append that destination to a log so the cleanup
 * assertions can look for leaks after the script exits.
 */
function createHarness({
  archiveNames,
  dittoFails = false,
  appsPerArchive = 1,
  codesignFails = false,
}: {
  archiveNames: string[];
  dittoFails?: boolean;
  appsPerArchive?: number;
  codesignFails?: boolean;
}): Harness {
  const dir = createTempDir();
  const binDir = join(dir, "bin");
  const releaseDir = join(dir, "release");
  const destinationsLog = join(dir, "destinations");
  const dittoLog = join(dir, "ditto-argv");
  const codesignLog = join(dir, "codesign-argv");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });

  const archives = archiveNames.map((name) => {
    const archive = join(releaseDir, name);
    writeFileSync(archive, "not really a zip");
    return archive;
  });

  const helperDirs = [
    "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release",
    "Contents/Resources/app.asar.unpacked/node_modules/posix-pty-reaper/build/Release",
  ];
  const helperNames = ["spawn-helper", "daintree_pty_supervisor"];

  writeExecutable(
    join(binDir, "ditto"),
    dittoFails
      ? `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dittoLog}"\necho 'ditto: corrupt archive' >&2\nexit 1\n`
      : [
          "#!/usr/bin/env bash",
          `printf '%s\\n' "$*" >> "${dittoLog}"`,
          // Invoked as: ditto -x -k <archive> <destination>
          'dest="${4:?}"',
          `for i in $(seq 1 ${appsPerArchive}); do`,
          '  app="$dest/Daintree$i.app"',
          '  mkdir -p "$app/Contents/MacOS"',
          '  printf "%s" "binary" > "$app/Contents/MacOS/Daintree"',
          `  mkdir -p "$app/${helperDirs[0]}" "$app/${helperDirs[1]}"`,
          `  printf "%s" "binary" > "$app/${helperDirs[0]}/${helperNames[0]}"`,
          `  printf "%s" "binary" > "$app/${helperDirs[1]}/${helperNames[1]}"`,
          "done",
          // Breadcrumb so the test can detect a destination the script failed to reap.
          `printf "%s\\n" "$dest" >> "${destinationsLog}"`,
          "",
        ].join("\n")
  );

  // Fails ONLY for the direct integrity check, never for the metadata queries
  // the three helper audits make. That asymmetry is what makes the "broken
  // signature" test prove the gate runs `--verify --deep --strict` itself
  // rather than merely inheriting a failure from a helper.
  writeExecutable(
    join(binDir, "codesign"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${codesignLog}"`,
      'if [[ "$*" == *--verify* ]]; then',
      ...(codesignFails
        ? [
            "  echo 'invalid signature (code or signature have been modified)' >&2",
            "  exit 1",
          ]
        : ["  exit 0"]),
      "fi",
      "printf '%s\\n' 'Identifier=org.daintree.app'",
      "printf '%s\\n' 'TeamIdentifier=ABCDE12345'",
      "printf '%s\\n' 'CodeDirectory v=20500 flags=0x10000(runtime) hashes=1+5'",
      "printf '%s\\n' 'Authority=Developer ID Application: Test'",
      "exit 0",
      "",
    ].join("\n")
  );

  writeExecutable(
    join(binDir, "file"),
    "#!/usr/bin/env bash\nprintf '%s\\n' 'Mach-O 64-bit executable arm64'\n"
  );
  writeExecutable(
    join(binDir, "lipo"),
    "#!/usr/bin/env bash\nif [[ \"$1\" == '-archs' ]]; then printf '%s\\n' 'arm64'; exit 0; fi\nexit 1\n"
  );

  return { binDir, releaseDir, destinationsLog, dittoLog, codesignLog, archives };
}

function readLog(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean);
}

function run(harness: Harness, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("bash", ["scripts/ci/verify-macos-update-archives.sh", ...args], {
    cwd: join(__dirname, ".."),
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

function extractionDestinations(harness: Harness): string[] {
  if (!existsSync(harness.destinationsLog)) return [];
  return readFileSync(harness.destinationsLog, "utf-8").split("\n").filter(Boolean);
}

const TEAM_ID = "ABCDE12345";

describe("verify-macos-update-archives.sh", () => {
  const itOnPosix = process.platform === "win32" ? it.skip : it;

  itOnPosix("extracts each archive it is handed exactly once", () => {
    const harness = createHarness({
      archiveNames: ["a-arm64-mac.zip", "b-x64-mac.zip", "c-universal-mac.zip"],
    });

    const result = run(harness, [TEAM_ID, ...harness.archives]);

    expect(result.status).toBe(0);
    // Distinct destinations alone would still pass if the script extracted the
    // SAME archive three times, so pin the source->destination mapping.
    const dittoCalls = readLog(harness.dittoLog);
    expect(dittoCalls).toHaveLength(3);
    for (const archive of harness.archives) {
      expect(dittoCalls.filter((c) => c.includes(archive))).toHaveLength(1);
    }
    expect(new Set(extractionDestinations(harness)).size).toBe(3);
  });

  itOnPosix("runs the deep strict integrity check on every extracted bundle", () => {
    const harness = createHarness({ archiveNames: ["a-arm64-mac.zip", "b-x64-mac.zip"] });

    run(harness, [TEAM_ID, ...harness.archives]);

    // Losing --deep or --strict would silently stop detecting a damaged seal,
    // which is the entire reason this gate exists.
    const verifyCalls = readLog(harness.codesignLog).filter((c) => c.includes("--verify"));
    expect(verifyCalls).toHaveLength(2);
    for (const call of verifyCalls) {
      for (const flag of DIRECT_VERIFY_FLAGS) expect(call).toContain(flag);
    }
  });

  itOnPosix("fails the batch when the direct integrity check rejects a bundle", () => {
    const harness = createHarness({
      archiveNames: ["good-arm64-mac.zip", "bad-x64-mac.zip"],
      codesignFails: true,
    });

    const result = run(harness, [TEAM_ID, ...harness.archives]);

    // The stub fails ONLY `--verify`, so the helper audits still pass — this
    // can only go red if the gate runs the integrity check itself.
    expect(result.status).not.toBe(0);
    // Every archive is still visited — the gate reports the full picture rather
    // than aborting on the first bad one.
    expect(extractionDestinations(harness)).toHaveLength(2);
  });

  itOnPosix("refuses to pass when handed no archives at all", () => {
    const harness = createHarness({ archiveNames: [] });

    const result = run(harness, [TEAM_ID]);

    // An unmatched `release/*.zip` glob must never read as "everything passed".
    expect(result.status).not.toBe(0);
    expect(readLog(harness.dittoLog)).toHaveLength(0);
  });

  itOnPosix("keeps auditing after one archive fails to extract", () => {
    const harness = createHarness({ archiveNames: ["corrupt.zip", "fine.zip"] });
    // Fail only the first archive, so the loop has somewhere to continue to.
    writeFileSync(
      join(harness.binDir, "ditto"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> "${harness.dittoLog}"`,
        'if [[ "$*" == *corrupt.zip* ]]; then exit 1; fi',
        'dest="${4:?}"',
        'mkdir -p "$dest/Daintree.app/Contents/MacOS"',
        'printf "%s" "binary" > "$dest/Daintree.app/Contents/MacOS/Daintree"',
        'mkdir -p "$dest/Daintree.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release"',
        'printf "%s" "b" > "$dest/Daintree.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper"',
        'mkdir -p "$dest/Daintree.app/Contents/Resources/app.asar.unpacked/node_modules/posix-pty-reaper/build/Release"',
        'printf "%s" "b" > "$dest/Daintree.app/Contents/Resources/app.asar.unpacked/node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"',
        `printf '%s\\n' "$dest" >> "${harness.destinationsLog}"`,
        "",
      ].join("\n")
    );
    chmodSync(join(harness.binDir, "ditto"), 0o755);

    const result = run(harness, [TEAM_ID, ...harness.archives]);

    expect(result.status).not.toBe(0);
    // A `set -e` abort on the first bad archive would leave the second unaudited
    // and its failure unreported.
    expect(readLog(harness.dittoLog)).toHaveLength(2);
    expect(readLog(harness.codesignLog).some((c) => c.includes("--verify"))).toBe(true);
  });

  itOnPosix("handles archive and extraction paths containing spaces", () => {
    const harness = createHarness({ archiveNames: ["a release-arm64-mac.zip"] });

    const result = run(harness, [TEAM_ID, ...harness.archives]);

    expect(result.status).toBe(0);
    expect(readLog(harness.dittoLog)).toHaveLength(1);
  });

  itOnPosix("fails when an archive cannot be extracted", () => {
    const harness = createHarness({
      archiveNames: ["corrupt-arm64-mac.zip"],
      dittoFails: true,
    });

    const result = run(harness, [TEAM_ID, ...harness.archives]);

    expect(result.status).not.toBe(0);
  });

  itOnPosix("fails when extraction does not yield exactly one app bundle", () => {
    const harness = createHarness({
      archiveNames: ["weird-arm64-mac.zip"],
      appsPerArchive: 2,
    });

    const result = run(harness, [TEAM_ID, ...harness.archives]);

    // A changed archive layout means the updater would not find the bundle
    // where it expects it, even if each copy is individually well signed.
    expect(result.status).not.toBe(0);
  });

  itOnPosix("fails a missing archive rather than skipping it", () => {
    const harness = createHarness({ archiveNames: ["present-arm64-mac.zip"] });

    const result = run(harness, [TEAM_ID, join(harness.releaseDir, "absent-x64-mac.zip")]);

    expect(result.status).not.toBe(0);
  });

  itOnPosix("rejects a malformed team id before touching any archive", () => {
    const harness = createHarness({ archiveNames: ["a-arm64-mac.zip"] });

    const result = run(harness, ["short", ...harness.archives]);

    expect(result.status).not.toBe(0);
    expect(extractionDestinations(harness)).toHaveLength(0);
  });

  itOnPosix.each([
    ["success", false],
    ["failure", true],
  ])("reaps its extraction directories on %s", (_label, codesignFails) => {
    const harness = createHarness({
      archiveNames: ["a-arm64-mac.zip", "b-x64-mac.zip"],
      codesignFails,
    });

    run(harness, [TEAM_ID, ...harness.archives]);

    const destinations = extractionDestinations(harness);
    expect(destinations).toHaveLength(2);
    // Peak disk matters: the runner is already holding three .app dirs, three
    // DMGs and three ZIPs by the time this gate runs.
    for (const dest of destinations) {
      expect(existsSync(dest)).toBe(false);
    }
  });
});
