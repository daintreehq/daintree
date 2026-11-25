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

export class FakeAkashConsole {
  readonly organizations: FakeAkashOrganization[] = [];
  readonly projects: FakeAkashProject[] = [];
  readonly keys = new Map<string, FakeAkashKey>();
  readonly providers: FakeAkashProvider[] = [];
  regionProviderCounts: Record<string, number> = {};
  readonly requests: FakeAkashRequest[] = [];
  private readonly failures: Failure[] = [];
  private readonly holds: FakeAkashMatch[] = [];
  /** The regions placement options list; null lists every region with a count. */
  placementRegions: string[] | null = null;

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
    return this.route(method, path, headers, body);
  };

  private route(method: string, path: string, headers: Headers, body: unknown): Response {
    if (method === "GET" && path === "/placement-options") return this.placementOptions();
    if (method === "POST" && path === "/bid-screening") return this.screen(body);

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
    if (method === "GET" && path === "/user/me") {
      if (!key.user) return json(403, { statusCode: 403, message: "Forbidden" });
      return json(200, {
        data: { id: "u1", userId: "u1", ...key.user, emailVerified: true, accountStatus: "active" },
      });
    }
    return json(404, { statusCode: 404, message: `No route ${method} ${path}` });
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
