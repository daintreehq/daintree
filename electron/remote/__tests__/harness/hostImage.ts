import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRunner } from "../../client/commandRunner.js";
import type { SshStreamSpawner } from "../../client/sshTransport.js";
import {
  armWatchdog,
  docker,
  exec,
  loopbackPort,
  removeContainers,
  RUN_LABEL,
  trackContainer,
} from "./docker.js";
import type { LinkMachine } from "./hostLink.js";
import { makeShortTempRoot } from "./privateSshd.js";
import { makeUserKey, writeSshRoute, type SshRoute } from "./sshRoute.js";

/**
 * The published Host image (build/host-image, docs/host-image.md) as a
 * container cloud runs it: its own entrypoint, its inputs from the environment
 * or a secrets volume, sshd on a loopback port. Unlike the e2e machine in
 * containerHost.ts it has no time limit of its own, so every container here
 * is also on a watchdog's list (see armWatchdog).
 */

const CONTEXT = fileURLToPath(new URL("../../../../build/host-image", import.meta.url));
const LOCAL_TAG = "daintree-host-image-e2e";
export const IMAGE_USER = "daintree";
const IMAGE_HOME = `/home/${IMAGE_USER}`;
const ALIAS = "daintree-host-image";
const SECRETS_DIR = "/run/secrets";
const UP_TIMEOUT_MS = 60_000;

/**
 * The image under test, as its ID: `named` (CI passes the image it built and
 * goes on to publish), else one built here from build/host-image.
 */
export async function hostImageUnderTest(named = process.env.DAINTREE_HOST_IMAGE): Promise<string> {
  if (!named) {
    await docker(["build", "--quiet", "--tag", LOCAL_TAG, CONTEXT], 15 * 60_000);
  }
  return docker(["image", "inspect", "--format", "{{.Id}}", named || LOCAL_TAG]);
}

export interface ImageInputs {
  /** The container's environment, handed to docker by name so no value is on a command line. */
  env?: Record<string, string>;
  /** A volume mounted read-only at /run/secrets, as a secret store mounts one. */
  secrets?: string;
}

/**
 * Writes `files` to a secrets volume, replacing what was there, through a
 * throwaway container of `image`: no bind mount, and no value on a command line.
 */
export async function writeSecrets(
  image: string,
  volume: string,
  files: Record<string, string>
): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const args = ["run", "--rm", "--label", RUN_LABEL, "--volume", `${volume}:/s`];
  const lines = ["set -e", "umask 077", "rm -f /s/*"];
  Object.entries(files).forEach(([name, contents], index) => {
    if (!/^[a-z_]+$/.test(name)) throw new Error(`Not a secret's name: ${name}`);
    env[`DAINTREE_E2E_SECRET_${index}`] = contents;
    args.push("--env", `DAINTREE_E2E_SECRET_${index}`);
    lines.push(`printf '%s' "$DAINTREE_E2E_SECRET_${index}" > /s/${name}`);
  });
  args.push("--entrypoint", "sh", image, "-c", lines.join("\n"));
  await docker(args, 60_000, env);
}

/** A login over ssh with fresh authentication: no control master, nothing but these options. */
export interface LoginAttempt {
  user?: string;
  identity: string;
  /** known_hosts holding the key the machine must present, under {@link ALIAS}. */
  knownHosts: string;
  command?: string;
}

export interface ImageHost extends LinkMachine {
  id: string;
  /** This machine's directory on the client: its keys, ssh_config and control sockets. */
  root: string;
  /** known_hosts under {@link ALIAS}, written before the start when the test gave the host key. */
  knownHosts: string;
  runCommand: CommandRunner;
  spawnSshStream: SshStreamSpawner;
  /** Run a shell line inside as root, around the path under test. */
  rootShell(script: string, timeoutMs?: number): Promise<string>;
  login(attempt: LoginAttempt): Promise<{ code: number; stderr: string }>;
  /**
   * Restarts the container on the same filesystem and waits for a login with
   * `userKey` (the same one unless given); fails with its output if it stops.
   */
  restart(userKey?: string): Promise<void>;
  logs(): Promise<string>;
  diagnostics(): Promise<string>;
  dispose(): Promise<void>;
}

async function containerState(id: string): Promise<{ running: boolean; exitCode: number }> {
  const [running, exitCode] = (
    await docker(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", id])
  ).split(" ");
  return { running: running === "true", exitCode: Number(exitCode) };
}

async function logsOf(id: string): Promise<string> {
  const result = await exec("docker", ["logs", id], 10_000);
  return `${result.stdout}${result.stderr}`;
}

export async function startImageHost(
  image: string,
  inputs: ImageInputs & {
    /** The private key to log in with; the test authorizes its `.pub` through the inputs. */
    userKey: string;
    /** The public key the container should present, for known_hosts before it starts. */
    hostPublicKey?: string;
  }
): Promise<ImageHost> {
  armWatchdog();
  const root = await makeShortTempRoot();
  let id: string | null = null;
  let route: SshRoute | null = null;
  let disposed = false;
  const clientDir = path.join(root, "c");
  const dispose = async () => {
    if (disposed) return;
    await route?.closeMaster(clientDir).catch(() => {});
    if (id) await removeContainers([id]);
    await fs.rm(root, { recursive: true, force: true });
    disposed = true;
  };

  try {
    await fs.mkdir(clientDir, { mode: 0o700 });
    let userKey = inputs.userKey;
    const knownHosts = path.join(root, "known_hosts");
    await fs.writeFile(
      knownHosts,
      inputs.hostPublicKey ? `${ALIAS} ${inputs.hostPublicKey.trim()}\n` : ""
    );

    const env: NodeJS.ProcessEnv = { ...process.env, ...inputs.env };
    const args = ["run", "--detach", "--label", RUN_LABEL, "--publish", "127.0.0.1:0:22"];
    for (const name of Object.keys(inputs.env ?? {})) args.push("--env", name);
    if (inputs.secrets) args.push("--volume", `${inputs.secrets}:${SECRETS_DIR}:ro`);
    args.push(image);
    id = await docker(args, 60_000, env);
    trackContainer(id);
    const container = id;

    const up = async () => {
      const deadline = Date.now() + UP_TIMEOUT_MS;
      for (;;) {
        const state = await containerState(container);
        if (!state.running) {
          throw new Error(
            `The container stopped (exit ${state.exitCode}): ${await logsOf(container)}`
          );
        }
        const port = await exec("docker", ["port", container, "22/tcp"], 10_000);
        if (port.code === 0 && port.stdout.trim()) {
          route = await writeSshRoute({
            root,
            alias: ALIAS,
            port: loopbackPort(port.stdout.trim()),
            user: IMAGE_USER,
            identity: userKey,
            knownHosts,
            strictHostKeyChecking: inputs.hostPublicKey ? "yes" : "accept-new",
            hostKeyAlias: ALIAS,
          });
          const ready = await route.runCommand("ssh", ["-o", "ConnectTimeout=3", ALIAS, "true"], {
            timeoutMs: 10_000,
          });
          if (ready.code === 0) return;
          if (Date.now() > deadline) {
            throw new Error(
              `The machine's sshd never answered: ${ready.stderr}\n${await logsOf(container)}`
            );
          }
        } else if (Date.now() > deadline) {
          throw new Error(`No port published: ${port.stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };
    await up();

    const current = (): SshRoute => {
      if (!route) throw new Error("No route to the machine");
      return route;
    };
    const port = async () => loopbackPort(await docker(["port", container, "22/tcp"]));
    return {
      id: container,
      root,
      knownHosts,
      target: ALIAS,
      connection: { kind: "ssh", target: ALIAS },
      home: IMAGE_HOME,
      clientDir,
      runCommand: (command, args, options) => current().runCommand(command, args, options),
      spawnSsh: (args) => current().spawnSsh(args),
      spawnSshStream: (args) => current().spawnSshStream(args),
      shell: (script, timeoutMs = 120_000) =>
        docker(["exec", "--user", IMAGE_USER, container, "sh", "-c", script], timeoutMs),
      rootShell: (script, timeoutMs = 120_000) =>
        docker(["exec", container, "sh", "-c", script], timeoutMs),
      async login(attempt) {
        // prettier-ignore
        const result = await exec("ssh", [
          "-F", "/dev/null",
          "-p", String(await port()),
          "-o", "BatchMode=yes",
          "-o", "IdentitiesOnly=yes",
          "-o", `IdentityFile=${attempt.identity}`,
          "-o", `UserKnownHostsFile=${attempt.knownHosts}`,
          "-o", "StrictHostKeyChecking=yes",
          "-o", `HostKeyAlias=${ALIAS}`,
          "-o", "ControlMaster=no",
          "-o", "ControlPath=none",
          "-o", "ConnectTimeout=5",
          "-o", "PreferredAuthentications=publickey",
          `${attempt.user ?? IMAGE_USER}@127.0.0.1`,
          attempt.command ?? "true",
        ], 30_000);
        return { code: result.code, stderr: result.stderr };
      },
      async restart(nextKey) {
        if (nextKey) userKey = nextKey;
        await current()
          .closeMaster(clientDir)
          .catch(() => {});
        await docker(["restart", container], 60_000);
        await up();
      },
      logs: () => logsOf(container),
      async diagnostics() {
        const parts = await Promise.all([
          exec("docker", ["logs", "--tail", "40", container], 10_000),
          exec(
            "docker",
            [
              "exec",
              "--user",
              IMAGE_USER,
              container,
              "sh",
              "-c",
              'tail -n 60 "$HOME/.cache/daintree/host.log" 2>/dev/null; ps -eo pid,ppid,comm,args | cut -c1-160',
            ],
            10_000
          ),
        ]);
        return parts.map((part) => `${part.stdout}${part.stderr}`).join("\n---\n");
      },
      dispose,
    };
  } catch (err) {
    await dispose().catch(() => {});
    throw err;
  }
}

/** An ed25519 host key made here, as Daintree makes one before a provider starts the machine. */
export async function makeHostKey(
  dir: string,
  name: string
): Promise<{ privateKey: string; publicKey: string }> {
  const file = await makeUserKey(path.join(dir, name), "");
  return {
    privateKey: await fs.readFile(file, "utf8"),
    publicKey: (await fs.readFile(`${file}.pub`, "utf8")).trim(),
  };
}
