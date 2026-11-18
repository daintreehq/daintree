import { signAwsRequest, awsUriEncode, type AwsSigningCredentials } from "./awsSigV4.js";
import {
  parseXml,
  xmlChild,
  xmlItems,
  xmlPath,
  xmlTags,
  xmlText,
  XmlParseError,
  type XmlNode,
} from "./awsXml.js";

/**
 * What a production account records as its API origin: every request goes to
 * that region's own `{service}.{region}.amazonaws.com`.
 */
export const AWS_PRODUCTION_API_URL = "https://amazonaws.com";

/** Development builds may point at a fake EC2 (tests); packaged builds never do. */
export const AWS_API_URL_ENV = "DAINTREE_AWS_API_URL";

const EC2_VERSION = "2016-11-15";
const STS_VERSION = "2011-06-15";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_PAGES = 50;

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;

/**
 * The AWS API origin this process may use. A packaged build always answers
 * production; a development build honours {@link AWS_API_URL_ENV} when it is
 * an http(s) URL. Accounts record the origin they were connected against, so
 * a key saved against production is never sent to an override.
 */
export function resolveAwsApiUrl(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (isPackaged) return AWS_PRODUCTION_API_URL;
  const override = env[AWS_API_URL_ENV]?.trim();
  if (!override) return AWS_PRODUCTION_API_URL;
  try {
    const url = new URL(override);
    if (url.protocol !== "https:" && url.protocol !== "http:") return AWS_PRODUCTION_API_URL;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return AWS_PRODUCTION_API_URL;
  }
}

/** The partitions whose endpoints, owners and sign-ins differ from AWS's standard regions. */
const OTHER_PARTITION = /^(?:cn|us-gov|[a-z]{2}-iso[a-z]*)-/;

/** A standard (commercial) AWS region: China, GovCloud and isolated regions aren't supported. */
export function isAwsRegion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    REGION.test(value) &&
    !OTHER_PARTITION.test(value)
  );
}

export function isEc2InstanceId(value: unknown): value is string {
  return typeof value === "string" && INSTANCE_ID.test(value);
}

/** Where one service's API for one region lives under an account's origin. */
export function awsEndpoint(apiUrl: string, service: "ec2" | "sts", region: string): URL {
  if (!isAwsRegion(region)) {
    throw new AwsApiError("invalid-request", "Not an AWS region", null, null, null);
  }
  if (apiUrl === AWS_PRODUCTION_API_URL)
    return new URL(`https://${service}.${region}.amazonaws.com/`);
  return new URL(`${apiUrl}/${service}/${region}/`);
}

/** Why an AWS request failed, typed so callers never match on message text. */
export type AwsErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "billing"
  | "rate-limited"
  | "capacity"
  | "conflict"
  | "invalid-request"
  | "server"
  | "network"
  | "timeout"
  | "cancelled"
  | "bad-response";

export class AwsApiError extends Error {
  constructor(
    readonly kind: AwsErrorKind,
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly requestId: string | null,
    /** The API action that was refused, for a permission failure. */
    readonly action: string | null = null
  ) {
    super(message);
    this.name = "AwsApiError";
  }

  /** The request may or may not have reached AWS: a mutation's outcome is unknown. */
  get outcomeUnknown(): boolean {
    return this.kind === "network" || this.kind === "timeout" || this.kind === "server";
  }
}

const UNAUTHORIZED_CODES = new Set([
  "AuthFailure",
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
  "ExpiredToken",
  "RequestExpired",
  "IncompleteSignature",
  "MissingAuthenticationToken",
  "UnrecognizedClientException",
  "InvalidAccessKeyId",
]);
const FORBIDDEN_CODES = new Set(["UnauthorizedOperation", "AccessDenied", "AccessDeniedException"]);
const BILLING_CODES = new Set(["OptInRequired", "PendingVerification", "Blocked"]);
const RATE_CODES = new Set(["RequestLimitExceeded", "Throttling", "ThrottlingException"]);
const CAPACITY_CODES = new Set([
  "InsufficientInstanceCapacity",
  "InsufficientCapacity",
  "InsufficientHostCapacity",
  "InstanceLimitExceeded",
  "VcpuLimitExceeded",
  // An instance type the region or zone doesn't offer.
  "Unsupported",
]);
const CONFLICT_CODES = new Set([
  "IncorrectInstanceState",
  "IncorrectState",
  "IdempotentParameterMismatch",
  "InvalidGroup.Duplicate",
  "InvalidPermission.Duplicate",
]);
const SERVER_CODES = new Set([
  "InternalError",
  "InternalFailure",
  "ServiceUnavailable",
  "Unavailable",
]);

function kindFor(status: number, code: string | null): AwsErrorKind {
  if (code) {
    if (UNAUTHORIZED_CODES.has(code)) return "unauthorized";
    if (FORBIDDEN_CODES.has(code)) return "forbidden";
    if (BILLING_CODES.has(code)) return "billing";
    if (RATE_CODES.has(code)) return "rate-limited";
    if (CAPACITY_CODES.has(code)) return "capacity";
    if (CONFLICT_CODES.has(code)) return "conflict";
    if (SERVER_CODES.has(code)) return "server";
    if (code.endsWith(".NotFound")) return "not-found";
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "invalid-request";
}

/** Strips anything credential-shaped from text that came back from AWS before it is shown or logged. */
export function redactAwsText(text: string, credentials?: AwsSigningCredentials): string {
  let out = text;
  for (const secret of [
    credentials?.secretAccessKey,
    credentials?.sessionToken,
    credentials?.accessKeyId,
  ]) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return (
    out
      // An encoded authorization failure is a long opaque blob only `sts decode-authorization-message` reads.
      .replace(/Encoded authorization failure message:\s*\S+/gi, "")
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, "[redacted]")
      .replace(/(X-Amz-Security-Token=|X-Amz-Signature=|Signature=)[^&\s,]+/gi, "$1[redacted]")
      .trim()
      .slice(0, 500)
  );
}

export interface AwsRequestContext {
  credentials: AwsSigningCredentials;
  /** The API origin the account was connected against. */
  apiUrl: string;
  region: string;
  signal?: AbortSignal;
}

/** One instance as DescribeInstances (or a lifecycle call) reports it. */
export interface Ec2Instance {
  instanceId: string;
  /** pending, running, shutting-down, terminated, stopping or stopped. */
  state: string;
  stateReason: string | null;
  /** The reason's code alone, such as `Client.InstanceInitiatedShutdown`. */
  stateReasonCode?: string | null;
  stateTransitionReason: string | null;
  instanceType: string | null;
  architecture: string | null;
  imageId: string | null;
  launchTime: string | null;
  publicIp: string | null;
  publicDnsName: string | null;
  /**
   * When the root volume was first attached: the instance's first launch.
   * `launchTime` moves with every start, so it can't say that.
   */
  createdAt: string | null;
  tags: Record<string, string>;
  /** `ebs` or `instance-store`; null when AWS didn't say. */
  rootDeviceType?: string | null;
  /** `spot`, `scheduled` or `capacity-block`; null for an on-demand instance. */
  instanceLifecycle?: string | null;
}

export interface Ec2Image {
  imageId: string;
  name: string;
  architecture: string | null;
  creationDate: string | null;
  rootDeviceName: string | null;
}

export interface Ec2Region {
  name: string;
  optInStatus: string | null;
}

export interface Ec2SecurityGroup {
  groupId: string;
  groupName: string;
  vpcId: string | null;
  /** Whether a rule already lets TCP 22 in from everywhere, over IPv4. */
  allowsSshFromAnywhere: boolean;
  tags: Record<string, string>;
}

export interface Ec2Subnet {
  subnetId: string;
  availabilityZone: string | null;
  /** Instances launched into it get a public IPv4 address unless the launch says otherwise. */
  mapsPublicIp: boolean;
}

export interface AwsCallerIdentity {
  account: string;
  arn: string;
  userId: string | null;
}

/** `Filter.N.Name` / `Filter.N.Value.M`, as the Query API names a filter. */
export type Ec2Filter = { name: string; values: string[] };

type Params = Array<[string, string]>;

function filterParams(filters: readonly Ec2Filter[]): Params {
  const out: Params = [];
  filters.forEach((filter, i) => {
    out.push([`Filter.${i + 1}.Name`, filter.name]);
    filter.values.forEach((value, j) => out.push([`Filter.${i + 1}.Value.${j + 1}`, value]));
  });
  return out;
}

function tagParams(prefix: string, tags: Record<string, string>): Params {
  const out: Params = [];
  Object.entries(tags).forEach(([key, value], i) => {
    out.push([`${prefix}.${i + 1}.Key`, key]);
    out.push([`${prefix}.${i + 1}.Value`, value]);
  });
  return out;
}

function parseInstance(item: XmlNode): Ec2Instance | null {
  const instanceId = xmlText(item, "instanceId");
  const state = xmlText(xmlChild(item, "instanceState"), "name");
  if (!instanceId || !state) return null;
  return {
    instanceId,
    state,
    stateReason: xmlText(xmlChild(item, "stateReason"), "message"),
    stateReasonCode: xmlText(xmlChild(item, "stateReason"), "code"),
    stateTransitionReason: xmlText(item, "reason"),
    instanceType: xmlText(item, "instanceType"),
    architecture: xmlText(item, "architecture"),
    imageId: xmlText(item, "imageId"),
    launchTime: xmlText(item, "launchTime"),
    publicIp: xmlText(item, "ipAddress"),
    publicDnsName: xmlText(item, "dnsName"),
    createdAt: rootAttachTime(item),
    tags: xmlTags(item),
    rootDeviceType: xmlText(item, "rootDeviceType"),
    instanceLifecycle: xmlText(item, "instanceLifecycle"),
  };
}

function rootAttachTime(item: XmlNode): string | null {
  const root = xmlText(item, "rootDeviceName");
  const mapping = xmlItems(item, "blockDeviceMapping").find(
    (entry) => xmlText(entry, "deviceName") === root
  );
  return xmlText(xmlChild(mapping, "ebs"), "attachTime");
}

function parseStateChange(root: XmlNode): Ec2Instance["state"] | null {
  const item = xmlItems(root, "instancesSet")[0];
  return xmlText(xmlChild(item, "currentState"), "name");
}

export interface AwsClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AwsApiError("cancelled", "Cancelled", null, null, null));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AwsApiError("cancelled", "Cancelled", null, null, null));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface CallOptions {
  /** Safe to send again after a lost response, a 5xx or throttling. */
  retry: boolean;
  /**
   * It changes something: once one send's outcome is unknown, a later
   * attempt's definite refusal doesn't prove the first did nothing.
   */
  mutation?: boolean;
}

/**
 * A narrow client for the parts of the EC2 and STS Query APIs Daintree uses,
 * signed with Signature Version 4. Every call names its region; nothing falls
 * back to a default one. Reads are retried with backoff, and so are the
 * mutations AWS makes safe to repeat (a create with its client token, a
 * start, stop or terminate, a tag); the rest are sent once.
 */
export class AwsClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: AwsClientOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
  }

  async callerIdentity(ctx: AwsRequestContext): Promise<AwsCallerIdentity> {
    const root = await this.call(ctx, "sts", "GetCallerIdentity", [], { retry: true });
    const result = xmlChild(root, "GetCallerIdentityResult");
    const account = xmlText(result, "Account");
    const arn = xmlText(result, "Arn");
    if (!account || !/^\d{12}$/.test(account) || !arn) {
      throw new AwsApiError(
        "bad-response",
        "AWS didn't say which account these keys belong to",
        null,
        null,
        null
      );
    }
    return { account, arn, userId: xmlText(result, "UserId") };
  }

  /** The regions this account has enabled. */
  async describeRegions(ctx: AwsRequestContext): Promise<Ec2Region[]> {
    const root = await this.call(ctx, "ec2", "DescribeRegions", [], { retry: true });
    return xmlItems(root, "regionInfo")
      .map((item) => ({
        name: xmlText(item, "regionName") ?? "",
        optInStatus: xmlText(item, "optInStatus"),
      }))
      .filter((region) => isAwsRegion(region.name));
  }

  /**
   * Instances by id, or every instance matching the filters, following
   * NextToken to the end. Past the page limit it fails rather than pass a
   * partial list off as complete.
   */
  async describeInstances(
    ctx: AwsRequestContext,
    query: { instanceIds?: string[]; filters?: Ec2Filter[]; firstPageOnly?: boolean }
  ): Promise<Ec2Instance[]> {
    const ids = query.instanceIds ?? [];
    for (const id of ids) {
      if (!isEc2InstanceId(id))
        throw new AwsApiError("invalid-request", "Not an EC2 instance id", null, null, null);
    }
    const base: Params = [
      ...ids.map((id, i): [string, string] => [`InstanceId.${i + 1}`, id]),
      ...filterParams(query.filters ?? []),
    ];
    const out: Ec2Instance[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Params = [...base];
      // MaxResults can't be combined with instance ids.
      if (ids.length === 0) params.push(["MaxResults", "100"]);
      if (token) params.push(["NextToken", token]);
      const root = await this.call(ctx, "ec2", "DescribeInstances", params, { retry: true });
      for (const reservation of xmlItems(root, "reservationSet")) {
        for (const item of xmlItems(reservation, "instancesSet")) {
          const instance = parseInstance(item);
          if (instance) out.push(instance);
        }
      }
      token = xmlText(root, "nextToken");
      if (!token || query.firstPageOnly) return out;
    }
    throw new AwsApiError(
      "bad-response",
      `This region has more than ${MAX_PAGES * 100} matching instances; Daintree can't list them all`,
      null,
      null,
      null
    );
  }

  async describeImages(
    ctx: AwsRequestContext,
    query: { owners: string[]; filters: Ec2Filter[] }
  ): Promise<Ec2Image[]> {
    const params: Params = [
      ...query.owners.map((owner, i): [string, string] => [`Owner.${i + 1}`, owner]),
      ...filterParams(query.filters),
    ];
    const root = await this.call(ctx, "ec2", "DescribeImages", params, { retry: true });
    const out: Ec2Image[] = [];
    for (const item of xmlItems(root, "imagesSet")) {
      const imageId = xmlText(item, "imageId");
      if (!imageId) continue;
      out.push({
        imageId,
        name: xmlText(item, "name") ?? "",
        architecture: xmlText(item, "architecture"),
        creationDate: xmlText(item, "creationDate"),
        rootDeviceName: xmlText(item, "rootDeviceName"),
      });
    }
    return out;
  }

  /** The region's default VPC, or null when the account has none there. */
  async defaultVpcId(ctx: AwsRequestContext): Promise<string | null> {
    const root = await this.call(
      ctx,
      "ec2",
      "DescribeVpcs",
      filterParams([{ name: "is-default", values: ["true"] }]),
      { retry: true }
    );
    return xmlText(xmlItems(root, "vpcSet")[0], "vpcId");
  }

  async describeSecurityGroups(
    ctx: AwsRequestContext,
    filters: Ec2Filter[]
  ): Promise<Ec2SecurityGroup[]> {
    const root = await this.call(ctx, "ec2", "DescribeSecurityGroups", filterParams(filters), {
      retry: true,
    });
    const out: Ec2SecurityGroup[] = [];
    for (const item of xmlItems(root, "securityGroupInfo")) {
      const groupId = xmlText(item, "groupId");
      if (!groupId) continue;
      const allowsSshFromAnywhere = xmlItems(item, "ipPermissions").some((permission) => {
        const protocol = xmlText(permission, "ipProtocol");
        const from = Number(xmlText(permission, "fromPort"));
        const to = Number(xmlText(permission, "toPort"));
        const coversSsh = protocol === "-1" || (protocol === "tcp" && from <= 22 && to >= 22);
        return (
          coversSsh &&
          xmlItems(permission, "ipRanges").some((range) => xmlText(range, "cidrIp") === "0.0.0.0/0")
        );
      });
      out.push({
        groupId,
        groupName: xmlText(item, "groupName") ?? "",
        vpcId: xmlText(item, "vpcId"),
        allowsSshFromAnywhere,
        tags: xmlTags(item),
      });
    }
    return out;
  }

  /** The VPC's default subnets, one per Availability Zone. */
  async defaultSubnets(ctx: AwsRequestContext, vpcId: string): Promise<Ec2Subnet[]> {
    const root = await this.call(
      ctx,
      "ec2",
      "DescribeSubnets",
      filterParams([
        { name: "vpc-id", values: [vpcId] },
        { name: "default-for-az", values: ["true"] },
      ]),
      { retry: true }
    );
    const out: Ec2Subnet[] = [];
    for (const item of xmlItems(root, "subnetSet")) {
      const subnetId = xmlText(item, "subnetId");
      if (!subnetId) continue;
      out.push({
        subnetId,
        availabilityZone: xmlText(item, "availabilityZone"),
        mapsPublicIp: xmlText(item, "mapPublicIpOnLaunch") === "true",
      });
    }
    return out;
  }

  async createSecurityGroup(
    ctx: AwsRequestContext,
    request: { name: string; description: string; vpcId: string; tags: Record<string, string> }
  ): Promise<string> {
    const root = await this.call(
      ctx,
      "ec2",
      "CreateSecurityGroup",
      [
        ["GroupName", request.name],
        ["GroupDescription", request.description],
        ["VpcId", request.vpcId],
        ["TagSpecification.1.ResourceType", "security-group"],
        ...tagParams("TagSpecification.1.Tag", request.tags),
      ],
      { retry: false }
    );
    const groupId = xmlText(root, "groupId");
    if (!groupId) {
      throw new AwsApiError(
        "bad-response",
        "AWS didn't return the new security group's id",
        null,
        null,
        null
      );
    }
    return groupId;
  }

  /** Lets SSH in from every IPv4 address; a rule that's already there counts as done. */
  async allowSshFromAnywhere(ctx: AwsRequestContext, groupId: string): Promise<void> {
    try {
      await this.call(
        ctx,
        "ec2",
        "AuthorizeSecurityGroupIngress",
        [
          ["GroupId", groupId],
          ["IpPermissions.1.IpProtocol", "tcp"],
          ["IpPermissions.1.FromPort", "22"],
          ["IpPermissions.1.ToPort", "22"],
          ["IpPermissions.1.IpRanges.1.CidrIp", "0.0.0.0/0"],
          ["IpPermissions.1.IpRanges.1.Description", "SSH"],
        ],
        { retry: true }
      );
    } catch (error) {
      if (error instanceof AwsApiError && error.code === "InvalidPermission.Duplicate") return;
      throw error;
    }
  }

  async runInstance(
    ctx: AwsRequestContext,
    request: {
      imageId: string;
      instanceType: string;
      clientToken: string;
      securityGroupId: string;
      /** Null lets EC2 choose among the default subnets. */
      subnetId: string | null;
      userData: string;
      rootDeviceName: string;
      rootVolumeGiB: number;
      tags: Record<string, string>;
    }
  ): Promise<Ec2Instance> {
    const root = await this.call(
      ctx,
      "ec2",
      "RunInstances",
      [
        ["ImageId", request.imageId],
        ["InstanceType", request.instanceType],
        ["MinCount", "1"],
        ["MaxCount", "1"],
        ["ClientToken", request.clientToken],
        ["SecurityGroupId.1", request.securityGroupId],
        ...(request.subnetId ? ([["SubnetId", request.subnetId]] as Params) : []),
        ["UserData", Buffer.from(request.userData, "utf8").toString("base64")],
        ["BlockDeviceMapping.1.DeviceName", request.rootDeviceName],
        ["BlockDeviceMapping.1.Ebs.VolumeSize", String(request.rootVolumeGiB)],
        ["BlockDeviceMapping.1.Ebs.VolumeType", "gp3"],
        ["BlockDeviceMapping.1.Ebs.DeleteOnTermination", "true"],
        // The default, said outright: the machine powering itself off when idle must stop it, never terminate it.
        ["InstanceInitiatedShutdownBehavior", "stop"],
        ["MetadataOptions.HttpTokens", "required"],
        ["MetadataOptions.HttpEndpoint", "enabled"],
        ["TagSpecification.1.ResourceType", "instance"],
        ...tagParams("TagSpecification.1.Tag", request.tags),
        ["TagSpecification.2.ResourceType", "volume"],
        ...tagParams("TagSpecification.2.Tag", request.tags),
      ],
      // The client token makes a resend return the instance the first send made.
      { retry: true, mutation: true }
    );
    const instance = parseInstance(
      xmlItems(root, "instancesSet")[0] ?? { name: "", children: [], text: "" }
    );
    if (!instance) {
      throw new AwsApiError(
        "bad-response",
        "AWS didn't describe the instance it launched",
        null,
        null,
        null
      );
    }
    return instance;
  }

  /** Starts a stopped instance; its state after the call. */
  async startInstance(ctx: AwsRequestContext, instanceId: string): Promise<string | null> {
    return parseStateChange(await this.instanceAction(ctx, "StartInstances", instanceId));
  }

  /** A normal stop that lets the OS shut down. Never forced from here. */
  async stopInstance(ctx: AwsRequestContext, instanceId: string): Promise<string | null> {
    return parseStateChange(await this.instanceAction(ctx, "StopInstances", instanceId));
  }

  async terminateInstance(ctx: AwsRequestContext, instanceId: string): Promise<string | null> {
    return parseStateChange(await this.instanceAction(ctx, "TerminateInstances", instanceId));
  }

  async createTags(
    ctx: AwsRequestContext,
    resourceId: string,
    tags: Record<string, string>
  ): Promise<void> {
    await this.call(
      ctx,
      "ec2",
      "CreateTags",
      [["ResourceId.1", resourceId], ...tagParams("Tag", tags)],
      { retry: true, mutation: true }
    );
  }

  /**
   * What the instance does when its own OS shuts down: `stop` or `terminate`;
   * null when AWS didn't say.
   */
  async shutdownBehavior(ctx: AwsRequestContext, instanceId: string): Promise<string | null> {
    if (!isEc2InstanceId(instanceId)) {
      throw new AwsApiError("invalid-request", "Not an EC2 instance id", null, null, null);
    }
    const root = await this.call(
      ctx,
      "ec2",
      "DescribeInstanceAttribute",
      [
        ["InstanceId", instanceId],
        ["Attribute", "instanceInitiatedShutdownBehavior"],
      ],
      { retry: true }
    );
    if (xmlText(root, "instanceId") !== instanceId) {
      throw new AwsApiError(
        "bad-response",
        "AWS described another instance's attribute",
        null,
        null,
        null
      );
    }
    return xmlText(xmlChild(root, "instanceInitiatedShutdownBehavior"), "value");
  }

  /** The instance's console output, decoded; null when nothing has been posted yet. */
  async consoleOutput(
    ctx: AwsRequestContext,
    instanceId: string,
    latest: boolean
  ): Promise<string | null> {
    if (!isEc2InstanceId(instanceId)) {
      throw new AwsApiError("invalid-request", "Not an EC2 instance id", null, null, null);
    }
    const params: Params = [["InstanceId", instanceId]];
    if (latest) params.push(["Latest", "true"]);
    const root = await this.call(ctx, "ec2", "GetConsoleOutput", params, { retry: true });
    const output = xmlText(root, "output");
    if (!output) return null;
    return Buffer.from(output, "base64").toString("utf8");
  }

  /**
   * Asks AWS whether the credentials may make this call, without making it.
   * "allowed" and "denied" are AWS's answer; "unknown" is a refusal that says
   * nothing about the permission (an id that doesn't exist, say). An answer
   * that never came (unreachable, throttled, a server error) or credentials
   * AWS doesn't accept throw: they are no verdict at all.
   */
  async dryRun(
    ctx: AwsRequestContext,
    action: string,
    params: Params
  ): Promise<"allowed" | "denied" | "unknown"> {
    try {
      await this.call(ctx, "ec2", action, [...params, ["DryRun", "true"]], { retry: true });
    } catch (error) {
      if (!(error instanceof AwsApiError)) throw error;
      if (error.code === "DryRunOperation") return "allowed";
      if (error.kind === "forbidden") return "denied";
      if (
        error.kind === "invalid-request" ||
        error.kind === "not-found" ||
        error.kind === "conflict" ||
        // A type the probe's zone doesn't offer says nothing about permission either.
        error.kind === "capacity"
      ) {
        return "unknown";
      }
      throw error;
    }
    // Every DryRun answers with an error; a success means the flag was ignored and it ran.
    throw new AwsApiError(
      "bad-response",
      `AWS ran ${action} instead of only checking it`,
      null,
      null,
      null,
      action
    );
  }

  private async instanceAction(
    ctx: AwsRequestContext,
    action: "StartInstances" | "StopInstances" | "TerminateInstances",
    instanceId: string
  ): Promise<XmlNode> {
    if (!isEc2InstanceId(instanceId)) {
      throw new AwsApiError("invalid-request", "Not an EC2 instance id", null, null, null);
    }
    // A repeat of a terminate joins the one under way; a start or stop resent after a lost answer
    // may be refused as the instance's state already moved, which the provider reads as joining it.
    return this.call(ctx, "ec2", action, [["InstanceId.1", instanceId]], {
      retry: true,
      mutation: true,
    });
  }

  private async call(
    ctx: AwsRequestContext,
    service: "ec2" | "sts",
    action: string,
    params: Params,
    options: CallOptions
  ): Promise<XmlNode> {
    let lastError: AwsApiError | null = null;
    let ambiguous: AwsApiError | null = null;
    const attempts = options.retry ? MAX_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(500 * 2 ** (attempt - 1), 4_000) + Math.random() * 250;
        await this.sleep(backoff, ctx.signal);
      }
      try {
        return await this.once(ctx, service, action, params);
      } catch (error) {
        if (!(error instanceof AwsApiError)) throw error;
        lastError = error;
        if (error.outcomeUnknown) ambiguous = error;
        const retriable =
          error.kind === "network" ||
          error.kind === "timeout" ||
          error.kind === "server" ||
          error.kind === "rate-limited";
        if (!retriable || ctx.signal?.aborted) {
          // A send that may have landed outranks a later refusal of its repeat.
          throw options.mutation && ambiguous && !error.outcomeUnknown ? ambiguous : error;
        }
      }
    }
    throw options.mutation && ambiguous ? ambiguous : lastError!;
  }

  private async once(
    ctx: AwsRequestContext,
    service: "ec2" | "sts",
    action: string,
    params: Params
  ): Promise<XmlNode> {
    const url = awsEndpoint(ctx.apiUrl, service, ctx.region);
    const body = [
      ["Action", action],
      ["Version", service === "ec2" ? EC2_VERSION : STS_VERSION],
      ...params,
    ]
      .map(([key, value]) => `${awsUriEncode(key!)}=${awsUriEncode(value!)}`)
      .join("&");
    if (ctx.signal?.aborted) throw new AwsApiError("cancelled", "Cancelled", null, null, null);
    const headers = signAwsRequest({
      method: "POST",
      url,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body,
      service,
      region: ctx.region,
      credentials: ctx.credentials,
      now: this.now(),
    });
    // fetch sets Host itself and refuses a caller's.
    delete headers.host;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const onAbort = () => timeout.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: timeout.signal,
        redirect: "error",
      });
      text = await readBounded(response);
    } catch (error) {
      if (error instanceof AwsApiError) throw error;
      if (ctx.signal?.aborted) throw new AwsApiError("cancelled", "Cancelled", null, null, null);
      if (timeout.signal.aborted) {
        throw new AwsApiError("timeout", "AWS didn't answer in time", null, null, null);
      }
      throw new AwsApiError("network", "Couldn't reach AWS", null, null, null);
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
    let root: XmlNode | null;
    try {
      root = text.trim().length > 0 ? parseXml(text) : null;
    } catch (error) {
      if (!(error instanceof XmlParseError)) throw error;
      root = null;
    }
    if (!response.ok) {
      // EC2: <Response><Errors><Error>; STS: <ErrorResponse><Error>.
      const errorNode = xmlPath(root, "Errors", "Error") ?? xmlChild(root, "Error");
      const code = xmlText(errorNode, "Code");
      const said = xmlText(errorNode, "Message");
      throw new AwsApiError(
        kindFor(response.status, code),
        redactAwsText(said ?? code ?? `AWS answered ${response.status}`, ctx.credentials),
        response.status,
        code,
        xmlText(root, "RequestID") ?? xmlText(root, "RequestId"),
        action
      );
    }
    if (!root) {
      throw new AwsApiError(
        "bad-response",
        "AWS answered in a shape Daintree doesn't recognise",
        response.status,
        null,
        null
      );
    }
    return root;
  }
}

/** The body as text, read a chunk at a time and abandoned as soon as it outgrows the limit. */
async function readBounded(response: Response): Promise<string> {
  const tooLarge = () =>
    new AwsApiError("bad-response", "AWS's answer was too large", response.status, null, null);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
