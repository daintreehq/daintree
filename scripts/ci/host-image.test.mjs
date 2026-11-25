import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load } from "js-yaml";

import { LINUX_HOST_PACKAGE_RELATIONS } from "../../shared/config/linuxHostPackages.ts";

// The Host image (build/host-image) and the workflow that publishes it, which
// never runs on a pull request: these are the checks a change to either gets
// before a tag publishes it. The container suite
// (electron/remote/__tests__/hostImage.container.e2e.test.ts) proves the image
// itself, in that workflow.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

// Shell comments dropped, so a commented-out command doesn't count as run.
const commands = (step) =>
  (step.run ?? "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

describe("the Host image", () => {
  it("installs exactly the packages a Linux Host needs, as setup elsewhere does", () => {
    const dockerfile = read("build/host-image/Dockerfile");
    const satisfy = /apt-get satisfy -y --no-install-recommends \\\n\s*('[^']+')/.exec(dockerfile);
    expect(satisfy?.[1]).toBe(LINUX_HOST_PACKAGE_RELATIONS);
  });
});

describe("publish-host-image workflow", () => {
  const workflow = load(read(".github/workflows/publish-host-image.yml"));
  // js-yaml reads the bare `on:` key as the boolean true.
  const triggers = workflow.on ?? workflow[true];
  const { smoke, publish } = workflow.jobs;
  const all = [...smoke.steps, ...publish.steps];
  const stepIndex = (steps, pattern) => {
    const index = steps.findIndex((s) => pattern.test(`${s.uses ?? ""}\n${commands(s)}`));
    expect(index, `step matching ${pattern}`).toBeGreaterThanOrEqual(0);
    return index;
  };
  const inOrder = (indexes) => expect(indexes).toEqual([...indexes].sort((a, b) => a - b));

  it("publishes only from a host-image version tag, and a manual run only rehearses", () => {
    expect(Object.keys(triggers).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(triggers.push).toEqual({ tags: ["host-image-v*"] });
    expect(triggers.workflow_dispatch ?? {}).not.toHaveProperty("inputs");
    expect(Object.keys(workflow.jobs)).toEqual(["smoke", "publish"]);
    expect(publish.needs).toBe("smoke");
    expect(publish.if).toContain("github.event_name == 'push'");
    expect(publish.if).toContain("github.repository == 'daintreehq/daintree'");
    expect(publish.if).toContain("needs.smoke.outputs.publish == 'true'");

    const resolve = commands(smoke.steps[stepIndex(smoke.steps, /GITHUB_REF_NAME#host-image-v/)]);
    expect(resolve).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(resolve).toMatch(/\^\(0\|\[1-9\]\[0-9\]\*\)\\\./);
  });

  it("gives write access to packages only to the job that publishes", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(smoke.permissions).toEqual({ contents: "read" });
    expect(publish.permissions.packages).toBe("write");
    expect(JSON.stringify(smoke)).not.toContain("secrets.");
  });

  it("pushes one tag, the version, and never latest", () => {
    const pushes = all.filter((s) => /\bdocker push\b/.test(commands(s)));
    expect(pushes).toHaveLength(1);
    expect(commands(pushes[0])).toContain('docker push "ghcr.io/${IMAGE_REPOSITORY}:${VERSION}"');
    expect(commands(pushes[0])).toContain(
      'docker tag daintree-host:candidate "ghcr.io/${IMAGE_REPOSITORY}:${VERSION}"'
    );
    for (const step of all) {
      const text = `${step.uses ?? ""}\n${commands(step)}\n${JSON.stringify(step.with ?? {})}`;
      expect(text, step.name).not.toMatch(/latest|--push\b|build-push-action/);
    }
  });

  it("tests the image it builds, then publishes those bytes and no others", () => {
    const build = stepIndex(smoke.steps, /docker buildx build/);
    const smokeTest = stepIndex(smoke.steps, /scripts\/host-install-e2e\.mjs image$/m);
    const save = stepIndex(smoke.steps, /docker save daintree-host:candidate/);
    inOrder([
      stepIndex(smoke.steps, /vitest run scripts\/ci\/host-image\.test\.mjs/),
      build,
      smokeTest,
      save,
    ]);
    expect(commands(smoke.steps[build])).toContain("--tag daintree-host:candidate");
    expect(commands(smoke.steps[build])).toContain("--provenance=false");
    expect(smoke.steps[smokeTest].env).toEqual({ DAINTREE_HOST_IMAGE: "daintree-host:candidate" });
    expect(smoke.steps[smokeTest].if).toBeUndefined();
    expect(existsSync(path.join(repoRoot, "build/host-image/Dockerfile"))).toBe(true);

    const load = stepIndex(publish.steps, /docker load/);
    const check = stepIndex(publish.steps, /host-image-registry\.mjs check /);
    const push = stepIndex(publish.steps, /docker push /);
    const resolve = stepIndex(publish.steps, /host-image-registry\.mjs resolve /);
    const attest = stepIndex(publish.steps, /actions\/attest-build-provenance@/);
    inOrder([load, check, push, resolve, attest]);
    expect(commands(publish.steps[load])).toContain('if [ "$loaded" != "$IMAGE_ID" ]');
    expect(publish.steps[push].if).toBe("${{ steps.check.outputs.push == 'true' }}");
    expect(publish.steps[attest].with["subject-digest"]).toBe(
      "${{ steps.resolve.outputs.digest }}"
    );
    for (const step of publish.steps) expect(step["continue-on-error"], step.name).toBeUndefined();
  });
});
