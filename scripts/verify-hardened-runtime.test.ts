import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "daintree-hardened-runtime-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

describe("verify-hardened-runtime.sh", () => {
  const itOnPosix = process.platform === "win32" ? it.skip : it;

  itOnPosix(
    "does not misclassify runtime signatures when grep exits before consuming codesign output",
    () => {
      const dir = createTempDir();
      const binDir = join(dir, "bin");
      const appDir = join(dir, "Daintree.app");
      const appExecutable = join(appDir, "Contents", "MacOS", "Daintree");

      mkdirSync(binDir, { recursive: true });
      mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
      writeFileSync(appExecutable, "fake executable");

      writeExecutable(
        join(binDir, "file"),
        "#!/usr/bin/env bash\nprintf '%s\\n' 'Mach-O 64-bit executable arm64'\n"
      );
      writeExecutable(
        join(binDir, "lipo"),
        "#!/usr/bin/env bash\nif [[ \"$1\" == '-archs' ]]; then printf '%s\\n' 'arm64'; exit 0; fi\nexit 1\n"
      );
      writeExecutable(
        join(binDir, "codesign"),
        [
          "#!/usr/bin/env bash",
          "printf '%s\\n' 'Executable=/tmp/Daintree'",
          "printf '%s\\n' 'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+5 location=embedded'",
          "yes 'Authority=Developer ID Application: Test' | head -n 2000",
          "",
        ].join("\n")
      );

      const result = spawnSync("bash", ["scripts/ci/verify-hardened-runtime.sh", appDir], {
        cwd: join(__dirname, ".."),
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("Broken pipe");
      expect(result.stdout).toContain("Verification SUCCESS");
      expect(result.stdout).not.toContain("Missing hardened runtime");
    }
  );
});
