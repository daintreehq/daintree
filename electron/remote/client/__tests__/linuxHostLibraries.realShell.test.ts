import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { libraryCheckScript, parseLibraryCheck } from "../linuxHostLibraries.js";

/**
 * The library check under a real /bin/sh, with stand-ins for `ldd` and an
 * AppImage's runtime on PATH: what it unpacks and where, what it hands ldd,
 * how it reads ldd's answer, and that nothing it unpacked is left behind.
 */

const FAKE_LDD = `#!/bin/sh
printf '%s\\n' "$1" > "$HOME/ldd-arg"
printf '%s\\n' "\${LD_LIBRARY_PATH:-}" > "$HOME/ldd-path"
cat "$HOME/ldd-out"
exit "$(cat "$HOME/ldd-code" 2>/dev/null || echo 0)"
`;

const FAKE_IMAGE = `#!/bin/sh
[ "$1" = --appimage-extract ] || exit 2
[ -f "$HOME/extract-fails" ] && exit 1
printf '%s\\n' "$2" >> "$HOME/patterns"
mkdir -p squashfs-root/usr/lib
case "$2" in
  daintree) printf 'ELF' > squashfs-root/daintree ;;
  '*.so*') : > squashfs-root/libffmpeg.so ;;
  usr/lib) : > squashfs-root/usr/lib/libappindicator3.so.1 ;;
esac
`;

let home: string;
let image: string;

function sh(script: string) {
  return spawnSync("/bin/sh", ["-c", script], {
    env: {
      HOME: home,
      PATH: `${path.join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      LD_LIBRARY_PATH: "/somewhere/else",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function lddSays(out: string, code = 0): void {
  fs.writeFileSync(path.join(home, "ldd-out"), out);
  fs.writeFileSync(path.join(home, "ldd-code"), String(code));
}

function leftOver(): string[] {
  const cache = path.join(home, ".cache", "daintree");
  return fs.existsSync(cache) ? fs.readdirSync(cache) : [];
}

const FOUND = [
  "\tlinux-vdso.so.1 (0x00007ffd)",
  "\tlibffmpeg.so => /tmp/x/squashfs-root/libffmpeg.so (0x00007f00)",
  "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f01)",
  "\t/lib64/ld-linux-x86-64.so.2 (0x00007f02)",
].join("\n");

describe.skipIf(process.platform === "win32")("library check (real shell)", () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "dt-libcheck-"));
    fs.mkdirSync(path.join(home, "bin"));
    fs.writeFileSync(path.join(home, "bin", "ldd"), FAKE_LDD, { mode: 0o755 });
    fs.mkdirSync(path.join(home, "Applications"));
    image = path.join(home, "Applications", "Daintree Nightly.AppImage");
    fs.writeFileSync(image, FAKE_IMAGE, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("names every library ldd can't find in the unpacked binary, and removes what it unpacked", () => {
    lddSays(
      [
        FOUND,
        "\tlibnspr4.so => not found",
        "\tlibnss3.so => not found",
        "\tlibnspr4.so => not found",
      ].join("\n"),
      1
    );
    const run = sh(libraryCheckScript({ executable: image, appImageExtractAndRun: true }));
    expect(run.status).toBe(0);
    expect(parseLibraryCheck(run.stdout)).toEqual({
      kind: "missing",
      libraries: ["libnspr4.so", "libnss3.so"],
    });
    expect(fs.readFileSync(path.join(home, "patterns"), "utf8").trim().split("\n")).toEqual([
      "daintree",
      "*.so*",
      "usr/lib",
    ]);
    const lddArg = fs.readFileSync(path.join(home, "ldd-arg"), "utf8").trim();
    expect(lddArg).toMatch(/\/\.cache\/daintree\/libcheck\.[^/]+\/squashfs-root\/daintree$/);
    // The image's own libraries, as its AppRun would add them, and nothing from the login.
    expect(fs.readFileSync(path.join(home, "ldd-path"), "utf8").trim()).toBe(
      path.join(path.dirname(lddArg), "usr", "lib")
    );
    expect(leftOver()).toEqual([]);
  });

  it("says ok when every library resolved", () => {
    lddSays(FOUND);
    const run = sh(libraryCheckScript({ executable: image }));
    expect(parseLibraryCheck(run.stdout)).toEqual({ kind: "ok" });
    expect(leftOver()).toEqual([]);
  });

  it.each([
    ["a binary ldd can't read", "\tnot a dynamic executable", 1],
    [
      "a symbol version rather than a library",
      `${FOUND}\n./daintree: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.38' not found (required by ./daintree)`,
      1,
    ],
    ["ldd failing with nothing resolved", "", 1],
  ])("concludes nothing from %s", (_label, out, code) => {
    lddSays(out, code);
    const run = sh(libraryCheckScript({ executable: image }));
    expect(parseLibraryCheck(run.stdout)).toEqual({ kind: "unknown" });
  });

  it("concludes nothing, and leaves nothing, when the image can't be unpacked", () => {
    lddSays(`${FOUND}\n\tlibnspr4.so => not found`);
    fs.writeFileSync(path.join(home, "extract-fails"), "");
    const run = sh(libraryCheckScript({ executable: image }));
    expect(run.status).toBe(0);
    expect(parseLibraryCheck(run.stdout)).toEqual({ kind: "unknown" });
    expect(fs.existsSync(path.join(home, "ldd-arg"))).toBe(false);
    expect(leftOver()).toEqual([]);
  });

  it("concludes nothing when the image isn't there", () => {
    lddSays(`${FOUND}\n\tlibnspr4.so => not found`);
    const run = sh(libraryCheckScript({ executable: `${image}.gone` }));
    expect(parseLibraryCheck(run.stdout)).toEqual({ kind: "unknown" });
    expect(leftOver()).toEqual([]);
  });
});
