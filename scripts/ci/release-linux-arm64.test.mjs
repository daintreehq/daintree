import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { load } from "js-yaml";

// Structural guard for the Linux arm64 release (#13253). electron-updater on
// arm64 polls `<prefix>-linux-arm64.yml` and on x64 `<prefix>-linux.yml`, so the
// two arches must build natively, keep their artifacts apart, and publish to
// separate feeds — a mixed feed would offer one arch the other's image.

const workflowsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows"
);
const loadWorkflow = (file) => load(readFileSync(path.join(workflowsDir, file), "utf8"));

const release = loadWorkflow("release-linux.yml");
const nightly = loadWorkflow("nightly-publish.yml");

const matrixOf = (job) => job.strategy?.matrix?.include ?? [];
const byArch = (job) => Object.fromEntries(matrixOf(job).map((entry) => [entry.arch, entry]));
const findStep = (job, pattern) => job.steps.find((s) => pattern.test(s.name ?? ""));

describe("release-linux arm64 build (#13253)", () => {
  const build = release.jobs["build-daintree"];
  const smoke = release.jobs["smoke-packaged"];
  const publish = release.jobs["publish-daintree"];

  it("builds each arch on its own native ubuntu-22.04 runner", () => {
    const arches = byArch(build);
    expect(Object.keys(arches).sort()).toEqual(["arm64", "x64"]);
    expect(arches.x64.runner).toBe("ubuntu-22.04");
    // 22.04 keeps the glibc the native modules link against at the .deb's
    // `libc6 (>= 2.34)` floor; 24.04-arm would raise it to 2.39.
    expect(arches.arm64.runner).toBe("ubuntu-22.04-arm");
    expect(build["runs-on"]).toBe("${{ matrix.runner }}");
  });

  it("maps each arch to the feed electron-updater polls for it", () => {
    const arches = byArch(build);
    expect(arches.x64.metadata_suffix).toBe("-linux");
    expect(arches.arm64.metadata_suffix).toBe("-linux-arm64");
  });

  it("packages for the matrix arch explicitly", () => {
    const step = findStep(build, /^Build$/);
    expect(step.run).toContain("--linux --${{ matrix.arch }}");
  });

  it("generates and validates the arch's own metadata inside its build", () => {
    const step = findStep(build, /validate update metadata/i);
    expect(step.env.METADATA_SUFFIX).toBe("${{ matrix.metadata_suffix }}");
    // The suffix must reach the filename, or arm64 would write the x64 feed.
    expect(step.run).toContain('"release/${UPDATE_METADATA_PREFIX}${METADATA_SUFFIX}.yml"');
    expect(step.run).toContain("generate-update-metadata.mjs linux");
    expect(step.run).toContain("validate-update-metadata.mjs");
  });

  it("uploads per-arch artifacts so the two builds never share a release dir", () => {
    const upload = findStep(build, /upload build artifacts/i);
    expect(upload.with.name).toBe("release-daintree-linux-${{ matrix.arch }}");
  });

  it("smoke-tests the packaged AppImage of both arches on native runners", () => {
    const arches = byArch(smoke);
    expect(arches.x64.runner).toBe("ubuntu-22.04");
    expect(arches.arm64.runner).toBe("ubuntu-22.04-arm");
    expect(smoke["runs-on"]).toBe("${{ matrix.runner }}");
    const download = findStep(smoke, /download build artifact/i);
    expect(download.with.name).toBe("release-daintree-linux-${{ matrix.arch }}");
  });

  it("publishes only after both arches built and smoked", () => {
    expect(publish.needs).toEqual(expect.arrayContaining(["build-daintree", "smoke-packaged"]));
  });

  it("starts each publish from a clean release/ so arches never cross-upload", () => {
    // Both arches publish from one job; the composite action's own checkout
    // runs `git clean -ffdx`, which empties the gitignored release/ before the
    // next arch's download.
    const action = load(
      readFileSync(path.join(workflowsDir, "../actions/publish-daintree/action.yml"), "utf8")
    );
    const checkoutIdx = action.runs.steps.findIndex((s) => s.uses?.startsWith("actions/checkout"));
    const downloadIdx = action.runs.steps.findIndex((s) =>
      s.uses?.startsWith("actions/download-artifact")
    );
    expect(checkoutIdx).toBeGreaterThanOrEqual(0);
    expect(action.runs.steps[checkoutIdx].with.clean).toBe(true);
    expect(checkoutIdx).toBeLessThan(downloadIdx);
  });

  it("publishes each arch's artifact to its own feed", () => {
    const publishes = publish.steps
      .filter((s) => s.uses?.includes("/publish-daintree"))
      .map((s) => s.with);
    expect(publishes).toHaveLength(2);
    const feeds = Object.fromEntries(publishes.map((w) => [w.artifact_name, w]));
    expect(feeds["release-daintree-linux-x64"]).toMatchObject({
      metadata_suffix: "-linux",
      release_platforms: "linux",
    });
    expect(feeds["release-daintree-linux-arm64"]).toMatchObject({
      metadata_suffix: "-linux-arm64",
      release_platforms: "linux-arm64",
    });
  });
});

describe("nightly-publish Linux arm64 (#13253)", () => {
  const build = nightly.jobs.build;
  const publish = nightly.jobs.publish;
  const linux = Object.fromEntries(
    matrixOf(build)
      .filter((entry) => entry.os.startsWith("ubuntu"))
      .map((entry) => [entry.os, entry])
  );

  it("builds Linux x64 and arm64 natively, each with its own feed", () => {
    expect(linux["ubuntu-22.04"].linux_metadata).toBe("latest-linux.yml");
    expect(linux["ubuntu-22.04-arm"].linux_metadata).toBe("latest-linux-arm64.yml");
  });

  it("runs every Linux-only step on both Linux runners", () => {
    for (const step of build.steps) {
      if (typeof step.if === "string" && /ubuntu/.test(step.if)) {
        expect(step.if, step.name).toBe("startsWith(matrix.os, 'ubuntu')");
      }
    }
  });

  it("downloads both Linux artifacts and verifies both feeds at the edge", () => {
    const downloads = publish.steps.filter((s) => s.uses?.startsWith("actions/download-artifact"));
    expect(downloads.map((s) => s.with.name)).toEqual(
      expect.arrayContaining(["nightly-ubuntu-22.04", "nightly-ubuntu-22.04-arm"])
    );
    const suffixes = publish.steps
      .filter((s) => s.run?.includes("verify-r2-metadata.mjs"))
      .map((s) => s.env.METADATA_SUFFIX);
    expect(suffixes).toEqual(expect.arrayContaining(["-linux", "-linux-arm64"]));
  });
});
