/**
 * An in-memory stand-in for the Akash Console API
 * (https://console-api.akash.network/v1/doc), answering the routes Daintree's
 * adapter calls with the documented envelopes, statuses and error codes. It
 * is a `fetch`, so the real client runs against it unchanged. Every request
 * is recorded, a route can be made to fail a number of times, and one can be
 * held open until its caller gives up.
 */

// The Console's key prefix, but broken up so nothing takes it for a live key.
export const FAKE_AKASH_KEY = "ac.sk.fake-akash-unit-0042";

export const AUDITOR = "akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63";

export interface FakeAkashOrganization {
  id: string;
  name: string;
  type: "personal" | "team";
}

export interface FakeAkashProject {
  id: string;
  organizationId: string;
  name: string;
  isDefault: boolean;
}

export interface FakeAkashKey {
  organizationId: string;
  /** The projects a key limited to some reaches; null for every project of its organization. */
  projectIds: string[] | null;
  /** May it deploy, or only read? */
  canDeploy: boolean;
  /** Projects it may only read, whatever `canDeploy` says. */
  readOnlyProjectIds?: string[];
  /** Who it signs in as; null when /user/me refuses it. */
  user: { email: string; username: string } | null;
}

/** An online provider with the room it has free now, in the chain's units. */
export interface FakeAkashProvider {
  owner: string;
  location: string | null;
  audited: boolean;
  freeMillicores: number;
  freeMemoryBytes: number;
  freeStorageBytes: number;
}

export interface FakeAkashRequest {
  method: string;
  path: string;
  /** The query string as sent, "" for none. */
  search: string;
  apiKey: string | null;
  projectId: string | null;
  organizationId: string | null;
  authorization: string | null;
  contentType: string | null;
  redirect: RequestRedirect | null;
  body: unknown;
  signal: AbortSignal | null;
}

/** Which requests a failure or hold applies to: a method, a path, and optionally what the body says. */
export interface FakeAkashMatch {
  method: string;
  path: RegExp;
  body?: (body: unknown) => boolean;
}

interface Failure extends FakeAkashMatch {
  times: number;
  respond: (request: FakeAkashRequest) => Response | Error;
}

function matches(match: FakeAkashMatch, request: FakeAkashRequest): boolean {
  return (
    match.method === request.method &&
    match.path.test(request.path) &&
    (match.body === undefined || match.body(request.body))
  );
}

/** A screening request's CPU, in millicores: which size it screens. */
export function screenedMillicores(body: unknown): number {
  const request = body as {
    resources?: Array<{ resource?: { cpu?: { units?: { val?: string } } } }>;
  };
  return Number(request.resources?.[0]?.resource?.cpu?.units?.val);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function unauthorized(): Response {
  return json(401, { statusCode: 401, message: "Unauthorized" });
}

function coded(status: number, code: string, message: string): Response {
  return json(status, {
    error: status === 403 ? "Forbidden" : "Error",
    message,
    code,
    type: "client_error",
  });
}

export type FakeAkashLeaseState = "active" | "insufficient_funds" | "closed";

export interface FakeAkashLease {
  provider: string;
  gseq: number;
  oseq: number;
  bseq: number;
  state: FakeAkashLeaseState;
  /** uact per block, as decimal text. */
  price: string;
  createdHeight: number;
  /** Where the provider forwards the service's port 22 now; null while it reports nothing. */
  forwarded: { host: string | null; externalPort: number } | null;
}

export interface FakeAkashBid {
  provider: string;
  gseq: number;
  oseq: number;
  bseq: number;
  state: "open" | "active" | "lost" | "closed";
  /** Per block, as decimal text. */
  price: string;
  denom: string;
}

export interface FakeAkashDeployment {
  owner: string;
  dseq: string;
  organizationId: string;
  projectId: string;
  name: string | null;
  state: "active" | "closed";
  createdHeight: number;
  groupState: "open" | "paused" | "insufficient_funds" | "closed";
  /** The SDL as a JSON object, as it was sent. */
  definition: unknown;
  secretEnv: unknown;
  bids: FakeAkashBid[];
  leases: FakeAkashLease[];
}

/** Who an account request comes from, once its key and project are checked. */
interface FakeAkashCaller {
  organizationId: string;
  owner: string;
  projectIds: string[];
  canDeploy: (projectId: string) => boolean;
  scoped: string | null;
}

/**
 * Console's own figures, from akash-network/console at
 * 201f4e89d3d5b97ccf98403008c49e778f4c2161: apps/api/src/utils/constants.ts
 * L4-L7 (6 s blocks, 30.437-day months) and
 * apps/api/src/deployment/services/deployment-reader/deployment-reader.service.ts
 * L661 (each lease's monthly cost, rounded to a whole udenom).
 */
const CONSOLE_AVERAGE_BLOCK_TIME = 6;
const CONSOLE_AVERAGE_DAYS_IN_MONTH = 30.437;
const CONSOLE_BLOCKS_IN_A_MONTH =
  (CONSOLE_AVERAGE_DAYS_IN_MONTH * 24 * 60 * 60) / CONSOLE_AVERAGE_BLOCK_TIME;

/** A lease's monthly cost as `GET /v1/deployment/{owner}/{dseq}` reports it. */
export function consoleMonthlyCostUDenom(pricePerBlock: string): number {
  return Math.round(parseFloat(pricePerBlock) * CONSOLE_BLOCKS_IN_A_MONTH);
}

/** The managed wallet an organization's deployments are owned by. */
export function fakeAkashWallet(organizationId: string): string {
  return `akash1wallet${organizationId.replace(/-/g, "").slice(0, 24)}`;
}

const BLOCK_MS = CONSOLE_AVERAGE_BLOCK_TIME * 1000;

export class FakeAkashConsole {
  readonly organizations: FakeAkashOrganization[] = [];
  readonly projects: FakeAkashProject[] = [];
  readonly keys = new Map<string, FakeAkashKey>();
  readonly providers: FakeAkashProvider[] = [];
  regionProviderCounts: Record<string, number> = {};
  readonly requests: FakeAkashRequest[] = [];
  private readonly failures: Failure[] = [];
  private readonly holds: FakeAkashMatch[] = [];
  private readonly afterwards: Array<
    FakeAkashMatch & { times: number; outcome: () => Response | Error }
  > = [];
  /** The regions placement options list; null lists every region with a count. */
  placementRegions: string[] | null = null;
  readonly deployments: FakeAkashDeployment[] = [];
  /** The chain's height now; each order and lease is a block later. */
  height = 21_000_000;
  /** When block 0 was made, so the height now reads as now. */
  readonly blockZeroMs = Date.now() - this.height * BLOCK_MS;
  /** The dseq the next order gets instead of the height, when set. */
  nextDseq: string | null = null;
  /** An active search spanning more deployments than this is refused with 422. */
  searchCap = Number.POSITIVE_INFINITY;
  /** Each provider's ingress host, as a lease reports it; unnamed ones get one from their address. */
  readonly ingressHosts = new Map<string, string | null>();
  private nextExternalPort = 31_022;

  constructor(readonly baseUrl = "https://console-api.akash.test/v1") {}

  /** The next `times` requests matching `method` and `path` get `respond()` instead of an answer. */
  fail(
    method: string,
    path: RegExp,
    respond: (request: FakeAkashRequest) => Response | Error,
    times = 1,
    body?: (body: unknown) => boolean
  ): void {
    this.failures.push({ method, path, body, times, respond });
  }

  /** Matching requests never answer; they reject once their caller aborts. */
  /** The next `times` matching requests are carried out, then answered with `outcome()` instead. */
  commitThen(method: string, path: RegExp, outcome: () => Response | Error, times = 1): void {
    this.afterwards.push({ method, path, times, outcome });
  }

  /** The next `times` matching requests are carried out, and only their answers lost. */
  lose(method: string, path: RegExp, times = 1): void {
    this.commitThen(
      method,
      path,
      () => new TypeError("fetch failed: the connection dropped before the answer came"),
      times
    );
  }

  hold(match: FakeAkashMatch): void {
    this.holds.push(match);
  }

  readonly fetch = async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    if (!url.href.startsWith(`${this.baseUrl}/`)) throw new TypeError(`fetch failed: ${url.href}`);
    const path = url.pathname.slice(new URL(this.baseUrl).pathname.length);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const request: FakeAkashRequest = {
      method,
      path,
      search: url.search,
      apiKey: headers.get("x-api-key"),
      projectId: headers.get("x-project-id"),
      organizationId: headers.get("x-organization-id"),
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      redirect: init.redirect ?? null,
      body,
      signal: init.signal ?? null,
    };
    this.requests.push(request);
    if (this.holds.some((hold) => matches(hold, request))) {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const failure = this.failures.find((entry) => entry.times > 0 && matches(entry, request));
    if (failure) {
      failure.times--;
      const outcome = failure.respond(request);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    const answer = this.route(method, path, headers, body, url.searchParams);
    const after = this.afterwards.find((entry) => entry.times > 0 && matches(entry, request));
    if (after) {
      after.times--;
      const outcome = after.outcome();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    return answer;
  };

  private route(
    method: string,
    path: string,
    headers: Headers,
    body: unknown,
    query: URLSearchParams
  ): Response {
    if (method === "GET" && path === "/placement-options") return this.placementOptions();
    if (method === "POST" && path === "/bid-screening") return this.screen(body);
    const details = /^\/deployment\/([^/]+)\/(\d+)$/.exec(path);
    if (method === "GET" && details) return this.deploymentDetails(details[1]!, details[2]!);
    const block = /^\/blocks\/(\d+)$/.exec(path);
    if (method === "GET" && block) return this.block(Number(block[1]));

    const key = this.keys.get(headers.get("x-api-key") ?? "");
    if (!key) return unauthorized();
    const organization = this.organizations.find((entry) => entry.id === key.organizationId)!;
    const reachable = this.projects.filter(
      (project) =>
        project.organizationId === organization.id &&
        (key.projectIds === null || key.projectIds.includes(project.id))
    );
    const scoped = headers.get("x-project-id");
    if (scoped !== null && !reachable.some((project) => project.id === scoped)) {
      return coded(403, "project_forbidden", "The project is outside this API key's reach");
    }
    const asJson = (project: FakeAkashProject) => ({
      id: project.id,
      name: project.name,
      slug: project.name.toLowerCase(),
      description: null,
      isDefault: project.isDefault,
      createdAt: "2026-11-01T00:00:00.000Z",
      createdBy: null,
      lastActivityAt: "2026-11-20T00:00:00.000Z",
      deployments: { activeCount: 0, preview: [] },
      access: {
        canDeploy: key.canDeploy && !(key.readOnlyProjectIds ?? []).includes(project.id),
        canManage: false,
      },
    });

    if (method === "GET" && path === "/organizations") {
      // An API key lists only the organization it acts in.
      return json(200, {
        data: [
          {
            ...organization,
            slug: organization.name.toLowerCase(),
            role: key.canDeploy ? "member" : "viewer",
            isActive: true,
            hasPaymentMethod: true,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }
    if (method === "GET" && path === "/projects") return json(200, { data: reachable.map(asJson) });
    const account: FakeAkashCaller = {
      organizationId: organization.id,
      owner: this.walletOf(organization.id),
      projectIds: scoped !== null ? [scoped] : reachable.map((project) => project.id),
      canDeploy: (projectId) =>
        key.canDeploy && !(key.readOnlyProjectIds ?? []).includes(projectId),
      scoped,
    };
    const deployments = this.deploymentRoutes(method, path, body, query, account);
    if (deployments) return deployments;
    if (method === "GET" && path === "/user/me") {
      if (!key.user) return json(403, { statusCode: 403, message: "Forbidden" });
      return json(200, {
        data: { id: "u1", userId: "u1", ...key.user, emailVerified: true, accountStatus: "active" },
      });
    }
    return json(404, { statusCode: 404, message: `No route ${method} ${path}` });
  }

  /** A bid on the deployment's one order, as a provider would place it. */
  bid(dseq: string, provider: string, price: string, denom = "uact"): FakeAkashBid {
    const deployment = this.deployments.find((entry) => entry.dseq === dseq);
    if (!deployment) throw new Error(`no deployment ${dseq}`);
    const bid: FakeAkashBid = { provider, gseq: 1, oseq: 1, bseq: 1, state: "open", price, denom };
    deployment.bids.push(bid);
    return bid;
  }

  blockTime(height: number): string {
    return new Date(this.blockZeroMs + height * BLOCK_MS).toISOString();
  }

  private walletOf(organizationId: string): string {
    return fakeAkashWallet(organizationId);
  }

  private block(height: number): Response {
    if (height < 1 || height > this.height) {
      return json(404, { statusCode: 404, message: "Block not found" });
    }
    return json(200, {
      height,
      datetime: this.blockTime(height),
      proposer: { operatorAddress: "v", moniker: "v", address: "v" },
      hash: "H",
      gasUsed: 0,
      gasWanted: 0,
      transactions: [],
    });
  }

  /** Public, as Console's own deployment page reads it: the monthly cost Console shows. */
  private deploymentDetails(owner: string, dseq: string): Response {
    const deployment = this.deployments.find(
      (entry) => entry.owner === owner && entry.dseq === dseq
    );
    if (!deployment) return json(404, { statusCode: 404, message: "Deployment not found" });
    const leases = deployment.leases.map((lease) => ({
      gseq: lease.gseq,
      oseq: lease.oseq,
      provider: { address: lease.provider, hostUri: "", isDeleted: false, attributes: [] },
      status: lease.state,
      monthlyCostUDenom: consoleMonthlyCostUDenom(lease.price),
      cpuUnits: 0,
      gpuUnits: 0,
      memoryQuantity: 0,
      storageQuantity: 0,
    }));
    return json(200, {
      owner,
      dseq,
      balance: 0,
      denom: "uact",
      status: deployment.state,
      totalMonthlyCostUDenom: leases.reduce((sum, lease) => sum + lease.monthlyCostUDenom, 0),
      leases,
      events: [],
      other: {},
    });
  }

  /** The service the SDL declares and whether it exposes port 22 to the internet. */
  private serviceOf(deployment: FakeAkashDeployment): { name: string; sshExposed: boolean } {
    const services = (deployment.definition as { services?: Record<string, unknown> } | null)
      ?.services;
    const [name, service] = Object.entries(services ?? {})[0] ?? ["app", {}];
    const expose = (service as { expose?: unknown[] }).expose ?? [];
    const sshExposed = expose.some((entry) => {
      const port = entry as { port?: number; to?: Array<{ global?: boolean }> };
      return port.port === 22 && (port.to ?? []).some((to) => to.global === true);
    });
    return { name, sshExposed };
  }

  private leaseJson(deployment: FakeAkashDeployment, lease: FakeAkashLease, withStatus: boolean) {
    const { name, sshExposed } = this.serviceOf(deployment);
    const forwarded =
      lease.state === "active" && lease.forwarded && sshExposed
        ? {
            [name]: [
              {
                ...(lease.forwarded.host === null ? {} : { host: lease.forwarded.host }),
                port: 22,
                externalPort: lease.forwarded.externalPort,
                proto: "TCP",
                name,
                available: 1,
              },
            ],
          }
        : {};
    return {
      id: {
        owner: deployment.owner,
        dseq: deployment.dseq,
        gseq: lease.gseq,
        oseq: lease.oseq,
        provider: lease.provider,
        bseq: lease.bseq,
      },
      state: lease.state,
      price: { denom: "uact", amount: `${lease.price}` },
      created_at: String(lease.createdHeight),
      closed_on: lease.state === "closed" ? String(this.height) : "0",
      ...(withStatus
        ? {
            status:
              lease.state === "active" && lease.forwarded !== null
                ? { forwarded_ports: forwarded, ips: {}, services: {} }
                : null,
          }
        : {}),
    };
  }

  private deploymentJson(deployment: FakeAkashDeployment, withStatus: boolean) {
    return {
      deployment: {
        id: { owner: deployment.owner, dseq: deployment.dseq },
        state: deployment.state,
        hash: "hash",
        created_at: String(deployment.createdHeight),
      },
      leases: deployment.leases.map((lease) => this.leaseJson(deployment, lease, withStatus)),
      escrow_account: {},
      name: deployment.name,
      groups: [
        {
          id: { owner: deployment.owner, dseq: deployment.dseq, gseq: 1 },
          state: deployment.groupState,
          group_spec: this.groupSpecOf(deployment),
          created_at: String(deployment.createdHeight),
        },
      ],
      settings: null,
      projectId: deployment.projectId,
    };
  }

  /** The group the chain recorded from the SDL: its placement and its one unit, in the chain's units. */
  private groupSpecOf(deployment: FakeAkashDeployment) {
    const definition = deployment.definition as {
      profiles?: {
        compute?: Record<string, { resources?: Record<string, unknown> }>;
        placement?: Record<string, { attributes?: Record<string, string> }>;
      };
    } | null;
    const resources = Object.values(definition?.profiles?.compute ?? {})[0]?.resources as
      | {
          cpu?: { units?: number };
          memory?: { size?: string };
          storage?: Array<{ size?: string }>;
        }
      | undefined;
    const attributes = Object.values(definition?.profiles?.placement ?? {})[0]?.attributes ?? {};
    const gib = (size: string | undefined) =>
      String(Number(/^(\d+)Gi$/.exec(size ?? "")?.[1]) * 1024 ** 3);
    return {
      name: "region",
      requirements: {
        signed_by: { all_of: [], any_of: [AUDITOR] },
        attributes: Object.entries(attributes).map(([key, value]) => ({ key, value })),
      },
      resources: resources
        ? [
            {
              resource: {
                id: 1,
                cpu: { units: { val: String((resources.cpu?.units ?? 0) * 1000) } },
                memory: { quantity: { val: gib(resources.memory?.size) } },
                storage: (resources.storage ?? []).map((volume) => ({
                  name: "default",
                  quantity: { val: gib(volume.size) },
                })),
                gpu: { units: { val: "0" } },
                endpoints: [],
              },
              count: 1,
              price: { denom: "uact", amount: "100000.000000000000000000" },
            },
          ]
        : [],
    };
  }

  private deploymentRoutes(
    method: string,
    path: string,
    body: unknown,
    query: URLSearchParams,
    caller: FakeAkashCaller
  ): Response | null {
    const visible = (deployment: FakeAkashDeployment) =>
      deployment.owner === caller.owner && caller.projectIds.includes(deployment.projectId);
    const notFound = () => json(404, { statusCode: 404, message: "Deployment not found" });
    if (method === "POST" && path === "/deployments") return this.createDeployment(body, caller);
    if (method === "GET" && path === "/deployments") {
      const state = query.get("state") ?? "active";
      const skip = Number(query.get("skip") ?? "0");
      const limit = Number(query.get("limit") ?? "100");
      const search = query.get("search")?.toLowerCase() ?? null;
      const projectId = query.get("projectId");
      if (
        (state !== "active" && state !== "closed") ||
        !Number.isInteger(skip) ||
        skip < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (search !== null && search.length > 256)
      ) {
        return json(400, { statusCode: 400, message: "Invalid query" });
      }
      const inState = this.deployments.filter(
        (deployment) =>
          visible(deployment) &&
          deployment.state === state &&
          (projectId === null || deployment.projectId === projectId)
      );
      if (search !== null && state === "active" && inState.length > this.searchCap) {
        return json(422, { statusCode: 422, message: "Too many active deployments to search" });
      }
      const matched =
        search === null
          ? inState
          : inState.filter(
              (deployment) =>
                (deployment.name ?? "").toLowerCase().includes(search) ||
                deployment.dseq.includes(search)
            );
      const page = matched.slice(skip, skip + limit);
      return json(200, {
        data: {
          deployments: page.map((deployment) => this.deploymentJson(deployment, false)),
          pagination: {
            total: matched.length,
            skip,
            limit,
            hasMore: skip + limit < matched.length,
          },
        },
      });
    }
    const one = /^\/deployments\/(\d+)$/.exec(path);
    if (one) {
      const dseq = one[1]!.replace(/^0+/, "");
      const deployment = this.deployments.find((entry) => entry.dseq === dseq && visible(entry));
      if (!deployment) return notFound();
      if (method === "GET") {
        // A deployment's own route carries the stored SDL, and no groups.
        const {
          groups: _groups,
          settings: _settings,
          ...detail
        } = this.deploymentJson(deployment, true);
        return json(200, {
          data: {
            ...detail,
            consoleSettings:
              deployment.definition === null
                ? null
                : {
                    sdl: "",
                    manifestVersion: "",
                    definition: deployment.definition,
                    templateId: null,
                  },
          },
        });
      }
      if (!caller.canDeploy(deployment.projectId)) {
        return coded(
          403,
          "project_forbidden",
          "The deployment is filed in a project you can't change"
        );
      }
      if (method === "DELETE") {
        if (deployment.state === "active") {
          deployment.state = "closed";
          deployment.groupState = "closed";
          for (const lease of deployment.leases) lease.state = "closed";
          for (const bid of deployment.bids) if (bid.state === "open") bid.state = "closed";
        }
        return json(200, { data: { success: true } });
      }
      if (method === "PATCH") {
        const name = (body as { data?: { name?: unknown } } | undefined)?.data?.name;
        if (typeof name !== "string" || name.length < 1 || name.length > 256) {
          return json(400, { statusCode: 400, message: "Invalid name" });
        }
        deployment.name = name;
        return json(200, { data: this.deploymentJson(deployment, true) });
      }
    }
    if (method === "GET" && path === "/bids") {
      const dseq = (query.get("dseq") ?? "").replace(/^0+/, "");
      const deployment = this.deployments.find((entry) => entry.dseq === dseq && visible(entry));
      return json(200, {
        data: (deployment?.bids ?? []).map((bid) => ({
          bid: {
            id: {
              owner: deployment!.owner,
              dseq: deployment!.dseq,
              gseq: bid.gseq,
              oseq: bid.oseq,
              provider: bid.provider,
              bseq: bid.bseq,
            },
            state: bid.state,
            price: { denom: bid.denom, amount: bid.price },
            created_at: String(deployment!.createdHeight + 1),
            resources_offer: [],
          },
          escrow_account: {},
        })),
      });
    }
    if (method === "POST" && path === "/leases") return this.createLease(body, caller, visible);
    return null;
  }

  private createDeployment(body: unknown, caller: FakeAkashCaller): Response {
    const data = (body as { data?: Record<string, unknown> } | undefined)?.data;
    if (!data || typeof data !== "object") {
      return json(400, { statusCode: 400, message: "Invalid request body" });
    }
    const sources = ["sdl", "definition", "service"].filter((field) => data[field] !== undefined);
    if (sources.length !== 1) {
      return json(400, {
        statusCode: 400,
        message: "Send exactly one of sdl, definition or service",
      });
    }
    const name = data.name;
    if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 256)) {
      return json(400, { statusCode: 400, message: "Invalid name" });
    }
    const projectId =
      typeof data.projectId === "string"
        ? data.projectId
        : (caller.scoped ??
          this.projects.find(
            (project) => project.organizationId === caller.organizationId && project.isDefault
          )?.id);
    if (!projectId || !caller.projectIds.includes(projectId)) {
      return json(404, { statusCode: 404, message: "Unknown project" });
    }
    if (!caller.canDeploy(projectId)) {
      return coded(403, "project_forbidden", "This key can't deploy into the project");
    }
    this.height++;
    const dseq = this.nextDseq ?? String(this.height);
    this.nextDseq = null;
    this.deployments.push({
      owner: caller.owner,
      dseq,
      organizationId: caller.organizationId,
      projectId,
      name: typeof name === "string" ? name : null,
      state: "active",
      createdHeight: this.height,
      groupState: "open",
      definition: data.definition ?? null,
      secretEnv: data.secretEnv,
      bids: [],
      leases: [],
    });
    return json(201, {
      data: { dseq, manifest: "[]", signTx: { code: 0, transactionHash: "TX", rawLog: "" } },
    });
  }

  private createLease(
    body: unknown,
    caller: FakeAkashCaller,
    visible: (deployment: FakeAkashDeployment) => boolean
  ): Response {
    const leases = (body as { leases?: unknown[] } | undefined)?.leases;
    const asked = leases?.[0] as
      { dseq?: string; gseq?: number; oseq?: number; provider?: string } | undefined;
    if (!Array.isArray(leases) || leases.length !== 1 || !asked) {
      return json(400, { statusCode: 400, message: "Invalid request body" });
    }
    const deployment = this.deployments.find(
      (entry) => entry.dseq === String(asked.dseq).replace(/^0+/, "") && visible(entry)
    );
    if (!deployment) return json(404, { statusCode: 404, message: "Deployment not found" });
    if (!caller.canDeploy(deployment.projectId)) {
      return coded(
        403,
        "project_forbidden",
        "The deployment is filed in a project you can't change"
      );
    }
    // The same request again, once its lease exists, sends the manifest again.
    const leased = deployment.leases.find(
      (lease) =>
        lease.state === "active" &&
        lease.provider === asked.provider &&
        lease.gseq === asked.gseq &&
        lease.oseq === asked.oseq
    );
    if (leased) {
      return json(200, {
        data: {
          deployment: this.deploymentJson(deployment, false).deployment,
          leases: [this.leaseJson(deployment, leased, true)],
          escrow_account: {},
        },
      });
    }
    const bid = deployment.bids.find(
      (entry) =>
        entry.provider === asked.provider && entry.gseq === asked.gseq && entry.oseq === asked.oseq
    );
    if (deployment.state !== "active" || !bid || bid.state !== "open") {
      return json(400, { statusCode: 400, message: "bid not open" });
    }
    bid.state = "active";
    for (const other of deployment.bids) if (other.state === "open") other.state = "closed";
    this.height++;
    const host = this.ingressHosts.has(bid.provider)
      ? this.ingressHosts.get(bid.provider)!
      : `${bid.provider}.ingress.test`;
    const lease: FakeAkashLease = {
      provider: bid.provider,
      gseq: bid.gseq,
      oseq: bid.oseq,
      bseq: bid.bseq,
      state: "active",
      price: bid.price,
      createdHeight: this.height,
      forwarded: { host, externalPort: this.nextExternalPort++ },
    };
    deployment.leases.push(lease);
    return json(200, {
      data: {
        deployment: this.deploymentJson(deployment, false).deployment,
        leases: [this.leaseJson(deployment, lease, true)],
        escrow_account: {},
      },
    });
  }

  private placementOptions(): Response {
    return json(200, {
      regions: this.placementRegions ?? Object.keys(this.regionProviderCounts),
      regionProviderCounts: this.regionProviderCounts,
      gpus: [
        {
          vendor: "nvidia",
          models: [
            {
              name: "a100",
              memory: ["80Gi"],
              interface: ["sxm"],
              providerCount: 2,
              availableUnits: 8,
              maxNodeFreeUnits: 8,
              variants: [],
            },
          ],
        },
      ],
    });
  }

  /** Matches as the Console's inventory does: free room on one provider for one replica, audited when asked. */
  private screen(body: unknown): Response {
    const request = body as {
      timezone?: unknown;
      requirements?: { signedBy?: { anyOf?: string[] } };
      resources?: Array<{
        resource: {
          cpu: { units: { val: string } };
          memory: { quantity: { val: string } };
          gpu: { units: { val: string } };
          storage: Array<{ quantity: { val: string } }>;
        };
        count: number;
        price: { denom: string; amount: string };
      }>;
    };
    const unit = request.resources?.[0];
    if (
      typeof request.timezone !== "string" ||
      request.resources?.length !== 1 ||
      !unit ||
      unit.count !== 1 ||
      !/^\d+(\.\d+)?$/.test(unit.price?.amount ?? "")
    ) {
      return json(400, {
        statusCode: 400,
        message: "Invalid request body",
        errors: { issues: [] },
      });
    }
    const millicores = Number(unit.resource.cpu.units.val);
    const memory = Number(unit.resource.memory.quantity.val);
    const storage = unit.resource.storage.reduce(
      (sum, volume) => sum + Number(volume.quantity.val),
      0
    );
    const auditedOnly = request.requirements?.signedBy?.anyOf?.includes(AUDITOR) === true;
    const matched = this.providers.filter(
      (provider) =>
        (!auditedOnly || provider.audited) &&
        Number(unit.resource.gpu.units.val) === 0 &&
        provider.freeMillicores >= millicores &&
        provider.freeMemoryBytes >= memory &&
        provider.freeStorageBytes >= storage
    );
    return json(200, {
      providers: matched.map((provider) => ({
        owner: provider.owner,
        hostUri: `https://${provider.owner}.provider.test:8443`,
        isAudited: provider.audited,
        createdAt: "2026-01-01T00:00:00.000Z",
        location: provider.location,
        organization: null,
        availableGpus: 0,
        incidents: [],
      })),
    });
  }
}
