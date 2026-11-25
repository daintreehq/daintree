import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
    .join("\n")
    .trim();

/** The Dockerfile's RUN instructions as commands: continuations joined, comments gone, split at `&&`. */
function runCommands(dockerfile) {
  const lines = dockerfile.split("\n").filter((line) => !line.trim().startsWith("#"));
  const joined = lines.join("\n").replace(/\\\n/g, " ");
  return joined
    .split("\n")
    .filter((line) => /^RUN\s/i.test(line))
    .flatMap((line) => line.replace(/^RUN\s+/i, "").split("&&"))
    .map((command) => command.trim().replace(/\s+/g, " "));
}

describe("the Host image", () => {
  it("installs exactly the packages a Linux Host needs, as setup elsewhere does, and sshd and tini", () => {
    const installs = runCommands(read("build/host-image/Dockerfile")).filter((command) =>
      /\bapt(-get)?\s+(install|satisfy)\b|\bdpkg\s+-i\b/.test(command)
    );
    expect(installs).toEqual([
      `DEBIAN_FRONTEND=noninteractive apt-get satisfy -y --no-install-recommends ${LINUX_HOST_PACKAGE_RELATIONS}`,
      "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server tini",
    ]);
  });
});

describe("publish-host-image workflow", () => {
  const text = read(".github/workflows/publish-host-image.yml");
  const workflow = load(text);
  // js-yaml reads the bare `on:` key as the boolean true.
  const triggers = workflow.on ?? workflow[true];
  const { smoke, publish } = workflow.jobs;
  const all = [...smoke.steps, ...publish.steps];
  const stepIndex = (steps, pattern) => {
    const matches = steps.flatMap((s, index) =>
      pattern.test(`${s.uses ?? ""}\n${commands(s)}`) ? [index] : []
    );
    expect(matches, `one step matching ${pattern}`).toHaveLength(1);
    return matches[0];
  };
  const strictlyInOrder = (indexes) => {
    for (let i = 1; i < indexes.length; i++) expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
  };

  it("publishes only from a host-image version tag in this repository; a manual run only rehearses", () => {
    expect(Object.keys(triggers).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(triggers.push).toEqual({ tags: ["host-image-v*"] });
    expect(triggers.workflow_dispatch ?? {}).not.toHaveProperty("inputs");
    expect(Object.keys(workflow.jobs)).toEqual(["smoke", "publish"]);
    expect(publish.needs).toBe("smoke");
    expect(publish.if).toBe(
      "${{ github.event_name == 'push' && github.repository == 'daintreehq/daintree' && needs.smoke.outputs.publish == 'true' }}"
    );
    expect(publish.env.VERSION).toBe("${{ needs.smoke.outputs.version }}");
    expect(publish.env.IMAGE_ID).toBe("${{ needs.smoke.outputs.image_id }}");

    const resolve = commands(smoke.steps[stepIndex(smoke.steps, /GITHUB_REF_NAME#host-image-v/)]);
    expect(resolve).toMatch(
      /grep -Eq '\^\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$'; then\n\s*echo [^\n]*\n\s*exit 1/
    );
    expect(resolve).toMatch(
      /if ! git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main; then\n\s*echo [^\n]*\n\s*exit 1/
    );
    expect(resolve).toMatch(/else\n\s*version="0\.0\.0-dry-run"\n\s*publish=false/);
  });

  it("serializes each tag's runs without cancelling one waiting its turn", () => {
    expect(workflow.concurrency).toEqual({
      group: "publish-host-image-${{ github.event_name }}-${{ github.ref }}",
      "cancel-in-progress": false,
    });
  });

  it("gives write access to packages only to the job that publishes, and lets no failure through", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(smoke.permissions).toEqual({ contents: "read" });
    expect(publish.permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
      attestations: "write",
    });
    expect(JSON.stringify(smoke)).not.toMatch(/secrets/);
    for (const job of [smoke, publish]) {
      expect(job["continue-on-error"]).toBeUndefined();
      for (const step of job.steps) expect(step["continue-on-error"], step.name).toBeUndefined();
    }
  });

  it("pushes one tag, the version, and never latest", () => {
    const uncommented = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(uncommented).not.toMatch(/latest/i);
    expect(uncommented).not.toMatch(/--push\b|build-push-action|imagetools create|crane |skopeo /);
    const pushes = all.flatMap((s) => commands(s).match(/\bdocker\s+(image\s+)?push\b.*/g) ?? []);
    expect(pushes).toEqual(['docker push "ghcr.io/${IMAGE_REPOSITORY}:${VERSION}"']);
    const push = publish.steps[stepIndex(publish.steps, /docker push /)];
    expect(commands(push)).toBe(
      [
        "set -euo pipefail",
        'docker tag daintree-host:candidate "ghcr.io/${IMAGE_REPOSITORY}:${VERSION}"',
        'docker push "ghcr.io/${IMAGE_REPOSITORY}:${VERSION}"',
      ].join("\n")
    );
    expect(push.if).toBe("${{ steps.check.outputs.push == 'true' }}");
  });

  it("tests the image it builds, then publishes those bytes and no others", () => {
    const contract = stepIndex(smoke.steps, /vitest run scripts\/ci\/host-image\.test\.mjs/);
    const build = stepIndex(smoke.steps, /docker buildx build/);
    const smokeTest = stepIndex(smoke.steps, /scripts\/host-install-e2e\.mjs/);
    const save = stepIndex(smoke.steps, /docker save daintree-host:candidate/);
    strictlyInOrder([contract, build, smokeTest, save]);
    const buildCommand = commands(smoke.steps[build]);
    expect(buildCommand).toMatch(/--tag daintree-host:candidate \\\n\s*build\/host-image$/m);
    expect(buildCommand).toContain("--platform linux/amd64");
    expect(buildCommand).toContain("--provenance=false");
    expect(commands(smoke.steps[smokeTest])).toBe("node scripts/host-install-e2e.mjs image");
    expect(smoke.steps[smokeTest].env).toEqual({ DAINTREE_HOST_IMAGE: "daintree-host:candidate" });
    expect(smoke.steps[smokeTest].if).toBeUndefined();
    const upload = smoke.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(upload.with["retention-days"]).toBeGreaterThanOrEqual(30);

    const loadStep = stepIndex(publish.steps, /docker load/);
    const check = stepIndex(publish.steps, /host-image-registry\.mjs check /);
    const push = stepIndex(publish.steps, /docker push /);
    const resolve = stepIndex(publish.steps, /host-image-registry\.mjs resolve /);
    const attest = stepIndex(publish.steps, /actions\/attest-build-provenance@/);
    strictlyInOrder([loadStep, check, push, resolve, attest]);
    const loading = commands(publish.steps[loadStep]);
    expect(loading).toContain('echo "${ARCHIVE_SHA256}  ${archive}" | sha256sum --check --strict');
    expect(loading).toMatch(/if \[ "\$loaded" != "\$IMAGE_ID" \]; then\n\s*echo [^\n]*\n\s*exit 1/);
    expect(commands(publish.steps[check])).toBe(
      'node scripts/ci/host-image-registry.mjs check "$IMAGE_REPOSITORY" "$VERSION" "$IMAGE_ID"'
    );
    expect(commands(publish.steps[resolve])).toBe(
      'node scripts/ci/host-image-registry.mjs resolve "$IMAGE_REPOSITORY" "$VERSION" "$IMAGE_ID"'
    );
    expect(publish.steps[attest].with).toEqual({
      "subject-name": "ghcr.io/${{ env.IMAGE_REPOSITORY }}",
      "subject-digest": "${{ steps.resolve.outputs.digest }}",
      "push-to-registry": true,
    });
    expect(workflow.env.IMAGE_REPOSITORY).toBe("daintreehq/daintree-host");
  });
});
