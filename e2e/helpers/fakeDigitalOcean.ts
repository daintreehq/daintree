import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { SYSTEM_SSH } from "./privateSshd";

/**
 * A stand-in for DigitalOcean's v2 API (https://docs.digitalocean.com/reference/api/),
 * covering the routes Daintree's adapter calls, with DigitalOcean's envelopes,
 * statuses and paging. Its Droplets are one private sshd on this Mac: a
 * Droplet reports `active` at 127.0.0.1, and its "first boot" then puts the
 * account key it was created with into that sshd's authorized_keys, as the
 * real first-boot script does for the `daintree` user.
 *
 * DigitalOcean serves sshd on port 22 as `daintree`, which this Mac can't. The
 * Shell's ssh is pointed at {@link writeDropletSshWrappers} instead, which keep
 * every argument Daintree passes and add only the private port and this
 * Mac's user, so the route Daintree writes stays the one a real Droplet gets.
 *
 * First boot can be held ({@link FakeDigitalOcean.holdFirstBoot}): the Droplet
 * then reports `active` and presents its host key while still turning the
 * account key away, as a real one does while its script runs.
 *
 * Every request is recorded so a test can assert what Daintree asked for.
 */

export const FAKE_DO_TOKEN = "dop_v1_e2e_fake_token_for_the_fake_api";
export const FAKE_DO_TEAM = { uuid: "team-e2e-0001", name: "E2E team" };

export interface FakeDigitalOceanRequest {
  method: string;
  path: string;
  body: unknown;
  at: number;
}

interface Action {
  id: number;
  status: "in-progress" | "completed" | "errored";
  type: string;
  started_at: string;
  completed_at: string | null;
  resource_id: number;
}

interface Droplet {
  id: number;
  name: string;
  status: "new" | "active" | "off";
  locked: boolean;
  size_slug: string;
  region: string;
  image: string;
  tags: string[];
  ssh_keys: number[];
  user_data: string;
  created_at: string;
}

interface SshKey {
  id: number;
  fingerprint: string;
  public_key: string;
  name: string;
}

export interface FakeDigitalOcean {
  url: string;
  requests: FakeDigitalOceanRequest[];
  droplets: Map<number, Droplet>;
  keys: Map<number, SshKey>;
  /** How long a boot, shutdown or power-on takes. */
  transitionMs: number;
  /** While true, an active Droplet's first boot waits for {@link releaseFirstBoot}. */
  holdFirstBoot: boolean;
  releaseFirstBoot(): void;
  stop(): Promise<void>;
}

const SIZES = [
  { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, disk: 25, price_hourly: 0.00893 },
  { slug: "s-1vcpu-2gb", memory: 2048, vcpus: 1, disk: 50, price_hourly: 0.01786 },
  { slug: "s-2vcpu-4gb", memory: 4096, vcpus: 2, disk: 80, price_hourly: 0.03571 },
  // Only one region has it, so it can't be offered beside the other.
  { slug: "c-4", memory: 8192, vcpus: 4, disk: 50, price_hourly: 0.125, regions: ["nyc3"] },
].map((size) => ({
  regions: ["nyc3", "ams3"],
  ...size,
  transfer: 2,
  price_monthly: Math.round(size.price_hourly * 672),
  available: true,
  description: "Basic",
}));

const REGIONS = [
  { slug: "nyc3", name: "New York 3", available: true },
  { slug: "ams3", name: "Amsterdam 3", available: true },
  { slug: "nyc2", name: "New York 2", available: false },
].map((region) => ({ ...region, sizes: SIZES.map((size) => size.slug), features: [] }));

const IMAGES = [
  { id: 1001, slug: "ubuntu-24-04-x64", distribution: "Ubuntu", name: "24.04 (LTS) x64" },
  { id: 1002, slug: "debian-12-x64", distribution: "Debian", name: "12 x64" },
  { id: 1003, slug: "fedora-42-x64", distribution: "Fedora", name: "42 x64" },
].map((image) => ({
  ...image,
  public: true,
  regions: ["nyc3", "ams3"],
  status: "available",
  type: "base",
  description: `${image.distribution} ${image.name}`,
}));

export async function startFakeDigitalOcean(params: {
  sshdRoot: string;
}): Promise<FakeDigitalOcean> {
  const authorizedKeys = path.join(params.sshdRoot, "authorized_keys");
  const requests: FakeDigitalOceanRequest[] = [];
  const droplets = new Map<number, Droplet>();
  const keys = new Map<number, SshKey>();
  const actions = new Map<number, Action>();
  const timers = new Set<NodeJS.Timeout>();
  const inFlight = new Set<Promise<void>>();
  const heldBoots: Array<() => void> = [];
  let nextId = 3_164_000;

  const fake: FakeDigitalOcean = {
    url: "",
    requests,
    droplets,
    keys,
    transitionMs: 1_500,
    holdFirstBoot: false,
    releaseFirstBoot() {
      fake.holdFirstBoot = false;
      for (const release of heldBoots.splice(0)) release();
    },
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      fake.releaseFirstBoot();
      await Promise.allSettled([...inFlight]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const track = (work: Promise<void>) => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const later = (fn: () => void | Promise<void>) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      track(Promise.resolve().then(fn));
    }, fake.transitionMs);
    timers.add(timer);
  };

  const view = (droplet: Droplet) => {
    const size = SIZES.find((entry) => entry.slug === droplet.size_slug) ?? SIZES[1]!;
    const image = IMAGES.find((entry) => entry.slug === droplet.image);
    return {
      id: droplet.id,
      name: droplet.name,
      memory: size.memory,
      vcpus: size.vcpus,
      disk: size.disk,
      locked: droplet.locked,
      status: droplet.status,
      created_at: droplet.created_at,
      size_slug: droplet.size_slug,
      size,
      image: image ?? null,
      region: REGIONS.find((entry) => entry.slug === droplet.region) ?? null,
      networks: {
        v4:
          droplet.status === "new"
            ? []
            : [
                { ip_address: "10.10.0.5", type: "private" },
                { ip_address: "127.0.0.1", type: "public" },
              ],
        v6: [],
      },
      tags: droplet.tags,
      features: [],
      backup_ids: [],
      snapshot_ids: [],
      volume_ids: [],
    };
  };

  /**
   * What first boot does on a real Droplet: the key reaches the login user once
   * setup is done, all at once (sshd never reads a half-written file).
   */
  const firstBoot = async (droplet: Droplet) => {
    if (fake.holdFirstBoot) await new Promise<void>((resolve) => heldBoots.push(resolve));
    const current = await fs.readFile(authorizedKeys, "utf8").catch(() => "");
    let next = current;
    for (const id of droplet.ssh_keys) {
      const key = keys.get(id);
      if (key && !next.includes(key.public_key)) next += `${key.public_key}\n`;
    }
    if (next === current) return;
    const staged = `${authorizedKeys}.${droplet.id}.tmp`;
    await fs.writeFile(staged, next);
    await fs.rename(staged, authorizedKeys);
  };

  const startAction = (droplet: Droplet, type: string, finish: () => void): Action => {
    const action: Action = {
      id: nextId++,
      status: "in-progress",
      type,
      started_at: new Date().toISOString(),
      completed_at: null,
      resource_id: droplet.id,
    };
    actions.set(action.id, action);
    droplet.locked = true;
    later(() => {
      finish();
      droplet.locked = false;
      action.status = "completed";
      action.completed_at = new Date().toISOString();
    });
    return action;
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const route = url.pathname.replace(/^\/v2/, "");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const method = req.method ?? "GET";
      requests.push({ method, path: `${route}${url.search}`, body, at: Date.now() });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      const fail = (status: number, id: string, message: string) =>
        send(status, { id, message, request_id: "req-fake" });
      if (req.headers.authorization !== `Bearer ${FAKE_DO_TOKEN}`) {
        fail(401, "unauthorized", "Unable to authenticate you");
        return;
      }
      const page = (key: string, items: unknown[]) =>
        send(200, { [key]: items, links: {}, meta: { total: items.length } });
      const dropletMatch = /^\/droplets\/(\d+)(\/actions)?$/.exec(route);
      const droplet = dropletMatch ? droplets.get(Number(dropletMatch[1])) : undefined;

      if (method === "GET" && route === "/account") {
        send(200, {
          account: {
            uuid: "acct-e2e-0001",
            email: "e2e@example.com",
            email_verified: true,
            status: "active",
            status_message: "",
            droplet_limit: 25,
            team: FAKE_DO_TEAM,
          },
        });
      } else if (method === "GET" && route === "/regions") {
        page("regions", REGIONS);
      } else if (method === "GET" && route === "/sizes") {
        page("sizes", SIZES);
      } else if (method === "GET" && route === "/images") {
        page("images", url.searchParams.get("type") === "distribution" ? IMAGES : []);
      } else if (method === "GET" && route.startsWith("/account/keys/")) {
        const fingerprint = decodeURIComponent(route.slice("/account/keys/".length));
        const key = [...keys.values()].find((entry) => entry.fingerprint === fingerprint);
        if (key) send(200, { ssh_key: key });
        else fail(404, "not_found", "The resource you were accessing could not be found.");
      } else if (method === "POST" && route === "/account/keys") {
        const request = (body ?? {}) as { name?: string; public_key?: string };
        const publicKey = String(request.public_key ?? "").trim();
        const [, blob] = publicKey.split(" ");
        if (!blob || /PRIVATE/.test(publicKey)) {
          fail(
            422,
            "unprocessable_entity",
            "Key invalid type, we support 'ssh-rsa', 'ssh-ed25519'"
          );
          return;
        }
        const digest = crypto.createHash("md5").update(Buffer.from(blob, "base64")).digest("hex");
        const key: SshKey = {
          id: nextId++,
          fingerprint: digest.match(/../g)!.join(":"),
          public_key: publicKey,
          name: String(request.name ?? ""),
        };
        keys.set(key.id, key);
        send(201, { ssh_key: key });
      } else if (method === "GET" && route === "/droplets") {
        const tag = url.searchParams.get("tag_name");
        const list = [...droplets.values()].filter((entry) => !tag || entry.tags.includes(tag));
        page("droplets", list.map(view));
      } else if (method === "POST" && route === "/droplets") {
        const request = (body ?? {}) as {
          name?: string;
          region?: string;
          size?: string;
          image?: string;
          tags?: string[];
          ssh_keys?: number[];
          user_data?: string;
        };
        const size = SIZES.find((entry) => entry.slug === request.size);
        const image = IMAGES.find((entry) => entry.slug === request.image);
        const region = REGIONS.find((entry) => entry.slug === request.region && entry.available);
        if (!region || !size?.regions.includes(region.slug)) {
          fail(422, "unprocessable_entity", "Size is not available in this region.");
          return;
        }
        if (!image?.regions.includes(region.slug)) {
          fail(422, "unprocessable_entity", "Image is not available in this region.");
          return;
        }
        const created: Droplet = {
          id: nextId++,
          name: String(request.name ?? ""),
          status: "new",
          locked: true,
          size_slug: String(request.size),
          region: String(request.region ?? ""),
          image: String(request.image ?? ""),
          tags: request.tags ?? [],
          ssh_keys: request.ssh_keys ?? [],
          user_data: String(request.user_data ?? ""),
          created_at: new Date().toISOString(),
        };
        droplets.set(created.id, created);
        later(async () => {
          created.status = "active";
          created.locked = false;
          track(firstBoot(created));
        });
        send(202, {
          droplet: view(created),
          links: { actions: [{ id: nextId++, rel: "create" }] },
        });
      } else if (method === "GET" && /^\/actions\/\d+$/.test(route)) {
        const action = actions.get(Number(route.slice("/actions/".length)));
        if (action) send(200, { action });
        else fail(404, "not_found", "The resource you were accessing could not be found.");
      } else if (!droplet) {
        fail(404, "not_found", "The resource you were accessing could not be found.");
      } else if (method === "GET" && !dropletMatch![2]) {
        send(200, { droplet: view(droplet) });
      } else if (method === "GET" && dropletMatch![2]) {
        const list = [...actions.values()]
          .filter((action) => action.resource_id === droplet.id)
          .reverse();
        page("actions", list);
      } else if (method === "POST" && dropletMatch![2]) {
        const request = (body ?? {}) as { type?: string; name?: string };
        if (droplet.locked) {
          fail(422, "unprocessable_entity", "Droplet already has a pending event.");
          return;
        }
        if (request.type === "shutdown" && droplet.status === "active") {
          send(201, { action: startAction(droplet, "shutdown", () => (droplet.status = "off")) });
        } else if (request.type === "power_on" && droplet.status === "off") {
          send(201, {
            action: startAction(droplet, "power_on", () => (droplet.status = "active")),
          });
        } else if (request.type === "rename" && request.name) {
          droplet.name = request.name;
          send(201, { action: startAction(droplet, "rename", () => {}) });
        } else {
          fail(
            422,
            "unprocessable_entity",
            `Can't ${request.type} a Droplet that is ${droplet.status}.`
          );
        }
      } else if (method === "DELETE" && !dropletMatch![2]) {
        droplets.delete(droplet.id);
        send(204, undefined);
      } else {
        fail(404, "not_found", `No route ${method} ${route}`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`;
  return fake;
}

/**
 * An `ssh` and an `ssh-keyscan` for `DAINTREE_SSH`: the system tools with the
 * private sshd's port and this Mac's user put in front of everything Daintree
 * passes. ssh takes the first value it's given for an option, so these win
 * over the `Port 22` and `User daintree` in Daintree's own route.
 */
export async function writeDropletSshWrappers(root: string, sshdPort: number): Promise<string> {
  const binDir = path.join(root, "do-bin");
  await fs.mkdir(binDir, { recursive: true });
  const user = os.userInfo().username;
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  await fs.writeFile(
    path.join(binDir, "ssh"),
    ["#!/bin/sh", `exec ${SYSTEM_SSH} -o Port=${sshdPort} -o User=${q(user)} "$@"`, ""].join("\n"),
    { mode: 0o755 }
  );
  await fs.writeFile(
    path.join(binDir, "ssh-keyscan"),
    [
      "#!/bin/sh",
      "prev=",
      "for a do",
      "  shift",
      `  if [ "$prev" = "-p" ]; then set -- "$@" ${sshdPort}; else set -- "$@" "$a"; fi`,
      "  prev=$a",
      "done",
      'exec /usr/bin/ssh-keyscan "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  return path.join(binDir, "ssh");
}
