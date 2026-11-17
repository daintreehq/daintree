import type {
  CloudAccountCheckResult,
  CloudCredentialValues,
  CloudHostError,
  CloudMachineType,
  CloudProviderInfo,
} from "../../../../shared/types/cloudHosts.js";
import type {
  CloudProvider,
  ProviderCatalog,
  ProviderCreateRequest,
  ProviderCredentials,
  ProviderResource,
  ProviderSshAccess,
} from "../provider.js";
import { AppError } from "../../../utils/errorTypes.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { normalizeHostKey, parseSshEndpoint } from "../sshEndpoint.js";
import type { AwsSigningCredentials } from "./awsSigV4.js";
import {
  AwsApiError,
  AwsClient,
  isAwsRegion,
  isEc2InstanceId,
  type AwsRequestContext,
  type Ec2Instance,
} from "./AwsClient.js";
import {
  CANONICAL_OWNER_ID,
  DEFAULT_EC2_IMAGE,
  EC2_IMAGES,
  EC2_INSTANCE_TYPES,
  EC2_ROOT_VOLUME_GIB,
  EC2_SECURITY_GROUP_NAME,
  EC2_SSH_USER,
  consoleHostKeys,
  ec2Image,
  ec2InstanceType,
  ec2InstanceTypeLabel,
  ec2MachineState,
  ec2RegionLabel,
  ec2TransitionTime,
  type Ec2Architecture,
} from "./awsCatalog.js";

const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/;
const SECRET_ACCESS_KEY = /^[A-Za-z0-9/+=]{16,128}$/;
const SESSION_TOKEN = /^[\x21-\x7e]{16,}$/;
/** A resource id names the region too: every call goes to that region's endpoint. */
const RESOURCE_ID = /^([a-z]{2}(?:-[a-z]+)+-\d{1,2})\/(i-[0-9a-f]{8,17})$/;
/** Regions listed at once when every region is searched. */
const REGION_CONCURRENCY = 4;
/** How long after its first boot the console may still be about to print the host keys. */
const CONSOLE_KEYS_WINDOW_MS = 10 * 60_000;
/** The most one SSH access resolution waits for them. */
const CONSOLE_KEYS_WAIT_MS = 90_000;
const CONSOLE_POLL_MS = 5_000;
/** Instance states that still hold a machine: a listing leaves out the terminated. */
const LIVE_STATES = ["pending", "running", "stopping", "stopped"];
/** The tag every machine Daintree creates carries (the lifecycle's marker label). */
const DAINTREE_TAG = "daintree";
/** Waits before asking again about an instance EC2 doesn't list yet. */
const NOT_FOUND_RETRIES = [2_000, 4_000];

/**
 * The permissions creating and managing machines needs, each with the DryRun
 * call that asks AWS about it. GetConsoleOutput is left out: without it the
 * person confirms each machine's host key on first connect instead.
 */
export const AWS_REQUIRED_ACTIONS = [
  "DescribeRegions",
  "DescribeInstances",
  "DescribeImages",
  "DescribeVpcs",
  "DescribeSecurityGroups",
  "CreateSecurityGroup",
  "AuthorizeSecurityGroupIngress",
  "RunInstances",
  "CreateTags",
  "StartInstances",
  "StopInstances",
  "TerminateInstances",
] as const;

/** A well-formed id no account has; AWS may answer it with not-found rather than its permission verdict. */
const PROBE_INSTANCE_ID = "i-0000000000000000d";

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

/** The signing credentials and home region from an entered set, checked for shape. */
export function awsCredentials(values: Readonly<CloudCredentialValues>): {
  signing: AwsSigningCredentials;
  region: string;
} {
  const accessKeyId = values.accessKeyId;
  const secretAccessKey = values.secretAccessKey;
  const sessionToken = values.sessionToken?.trim() || null;
  const region = values.region?.toLowerCase();
  if (typeof accessKeyId !== "string" || !ACCESS_KEY_ID.test(accessKeyId)) {
    throw invalid("That doesn't look like an access key ID: it's letters and digits, like AKIA….");
  }
  if (typeof secretAccessKey !== "string" || !SECRET_ACCESS_KEY.test(secretAccessKey)) {
    throw invalid("That doesn't look like a secret access key.");
  }
  if (sessionToken !== null && !SESSION_TOKEN.test(sessionToken)) {
    throw invalid("That doesn't look like a session token.");
  }
  if (sessionToken === null && accessKeyId.startsWith("ASIA")) {
    throw invalid("Temporary keys (those starting ASIA) need their session token too.");
  }
  if (!isAwsRegion(region)) throw invalid("The region should look like us-east-1.");
  return { signing: { accessKeyId, secretAccessKey, sessionToken }, region };
}

/** `us-east-2/i-0123…`, split; null for anything else. */
export function parseEc2ResourceId(
  resourceId: string
): { region: string; instanceId: string } | null {
  const match = RESOURCE_ID.exec(resourceId);
  if (!match || !isEc2InstanceId(match[2])) return null;
  return { region: match[1]!, instanceId: match[2]! };
}

/**
 * Who the keys sign in as, stable across sessions: an assumed role's session
 * name changes with every set of temporary keys, so it is dropped.
 */
export function awsIdentity(arn: string): string {
  const match = /^(arn:[\w-]+:sts::\d{12}:assumed-role\/[^/]+)\/.+$/.exec(arn);
  return match ? match[1]! : arn;
}

export function ec2ResourceId(region: string, instanceId: string): string {
  return `${region}/${instanceId}`;
}

function requireResourceId(resourceId: string): { region: string; instanceId: string } {
  const parsed = parseEc2ResourceId(resourceId);
  if (!parsed) throw new AwsApiError("not-found", "Not an EC2 machine id", null, null, null);
  return parsed;
}

export function ec2Resource(region: string, instance: Ec2Instance): ProviderResource {
  const spec = ec2InstanceType(instance.instanceType);
  const machine = ec2MachineState(instance.state);
  const reason = instance.stateReason;
  return {
    resourceId: ec2ResourceId(region, instance.instanceId),
    name: instance.tags.Name || instance.instanceId,
    machine,
    rawState: instance.state,
    machineType: instance.instanceType,
    vcpu: spec?.vcpu ?? null,
    memoryGB: spec?.memoryGB ?? null,
    autoStopAt: null,
    lifetimeSeconds: null,
    stoppedAt: machine === "stopped" ? ec2TransitionTime(instance.stateTransitionReason) : null,
    createdAt: instance.createdAt,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    snapshotsDisabled: false,
    labels: instance.tags,
    restricted: false,
    // A stop someone asked for isn't a failure; anything else that stopped it is AWS's word on why.
    error:
      reason && machine !== "running" && !/^Client\.UserInitiated/.test(reason) ? reason : null,
  };
}

/** Cloud-init's instruction to authorize the account's key for the image's default user. */
export function ec2UserData(publicKey: string): string {
  if (/PRIVATE KEY/.test(publicKey) || /[\r\n]/.test(publicKey)) {
    throw invalid("Refusing to send anything but a one-line public key.");
  }
  // JSON is a YAML flow scalar, so a comment holding `#` or `:` stays inside the key.
  return `#cloud-config\nssh_authorized_keys:\n  - ${JSON.stringify(publicKey)}\n`;
}

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  }
  return out;
}

export interface AwsProviderDeps {
  client: AwsClient;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Amazon EC2 as a cloud provider. A machine is an EBS-backed Ubuntu instance
 * in the region's default VPC, reached over SSH at its public address. There
 * is no automatic stop; a stopped machine keeps its disk, which is still
 * billed. Its host key comes from the console output when cloud-init has
 * printed it there, and otherwise from the person, on first connect.
 */
export class AwsProvider implements CloudProvider {
  readonly id = "aws" as const;
  private readonly client: AwsClient;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(deps: AwsProviderDeps) {
    this.client = deps.client;
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ??
      ((ms, signal) =>
        new Promise((resolve, reject) => {
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
        }));
  }

  info(platform: NodeJS.Platform): CloudProviderInfo {
    return {
      id: "aws",
      name: "AWS",
      description:
        "EC2 instances in your own AWS account. They run until stopped; a stopped instance keeps its disk.",
      apiKeyUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
      dashboardUrl: "https://console.aws.amazon.com/ec2/home#Instances:",
      docsUrl: "https://docs.aws.amazon.com/ec2/",
      credentialFields: [
        {
          id: "accessKeyId",
          label: "Access key ID",
          secret: true,
          input: "single-line",
          required: true,
          help: "From an IAM user's security credentials, starting AKIA (or ASIA for temporary keys).",
        },
        {
          id: "secretAccessKey",
          label: "Secret access key",
          secret: true,
          input: "single-line",
          required: true,
          help: null,
        },
        {
          id: "sessionToken",
          label: "Session token",
          secret: true,
          input: "single-line",
          required: false,
          help: "Only for temporary keys.",
        },
        {
          id: "region",
          label: "Region",
          secret: false,
          input: "single-line",
          required: true,
          help: "Where the keys are checked and machines are created unless you choose another, such as us-east-1.",
        },
      ],
      capabilities: {
        persistence: {
          kept: "Files on its disk",
          lost: "memory and running processes",
          retentionDays: null,
          saveRetryBilled: false,
          stoppedComputeBilled: false,
          stoppedStorageBilled: true,
        },
        typicalStartSeconds: 60,
        lifetime: { kind: "none" },
        sshTrust: "api-or-confirm",
        transport: "direct",
        tunnel: null,
        provisioning: {
          location: "required",
          image: "required",
          network: "none",
          sshKey: "at-create",
        },
        deletion: true,
      },
      unsupportedReason:
        platform === "win32"
          ? "Cloud hosts need Daintree for macOS or Linux. Daintree for Windows reaches hosts through WSL only."
          : null,
    };
  }

  private ctx(credentials: ProviderCredentials, region?: string): AwsRequestContext {
    const { signing, region: home } = awsCredentials(credentials.values);
    return {
      credentials: signing,
      apiUrl: credentials.apiUrl,
      region: region ?? home,
      signal: credentials.signal,
    };
  }

  async checkCredentials(
    values: Readonly<CloudCredentialValues>,
    apiUrl: string,
    signal?: AbortSignal
  ): Promise<CloudAccountCheckResult> {
    const { signing, region } = awsCredentials(values);
    const ctx: AwsRequestContext = { credentials: signing, apiUrl, region, signal };
    const identity = await this.client.callerIdentity(ctx);
    const missing = await this.missingPermissions(ctx);
    if (missing.length > 0) {
      const list = missing.map((action) => `ec2:${action}`).join(", ");
      throw new AppError({
        code: "PERMISSION",
        message: `AWS credentials lack ${list}`,
        userMessage: `These credentials can't do everything Daintree needs to create and manage EC2 machines in ${region}. Missing: ${list}. Add them to the IAM policy for ${identity.arn}, or use other keys.`,
      });
    }
    return {
      identity: awsIdentity(identity.arn),
      scopes: [
        {
          scope: { kind: "account", id: identity.account, name: `AWS account ${identity.account}` },
          active: true,
        },
      ],
    };
  }

  /**
   * The required actions AWS says these credentials may not take, asked with
   * DryRun in the home region. An answer that isn't a verdict (a probe id that
   * doesn't exist, no default VPC to name) isn't counted as missing.
   */
  private async missingPermissions(ctx: AwsRequestContext): Promise<string[]> {
    const verdicts = new Map<string, "allowed" | "denied" | "unknown">();
    const probe = async (action: string, params: Array<[string, string]>) => {
      verdicts.set(action, await this.client.dryRun(ctx, action, params));
    };
    await Promise.all([
      probe("DescribeRegions", []),
      probe("DescribeInstances", []),
      probe("DescribeImages", [["Owner.1", CANONICAL_OWNER_ID]]),
      probe("DescribeVpcs", []),
      probe("DescribeSecurityGroups", []),
    ]);
    const optional = async <T>(read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read();
      } catch (error) {
        if (
          error instanceof AwsApiError &&
          (error.kind === "unauthorized" || error.kind === "cancelled")
        ) {
          throw error;
        }
        return null;
      }
    };
    const [vpcId, image, instance] = await Promise.all([
      verdicts.get("DescribeVpcs") === "allowed"
        ? optional(() => this.client.defaultVpcId(ctx))
        : null,
      verdicts.get("DescribeImages") === "allowed"
        ? optional(() => this.resolveImage(ctx, DEFAULT_EC2_IMAGE, "x86_64"))
        : null,
      verdicts.get("DescribeInstances") === "allowed"
        ? optional(
            async () =>
              // A Daintree machine is what the start, stop and terminate verdicts are about.
              (
                await this.client.describeInstances(ctx, {
                  filters: [
                    { name: "tag-key", values: [DAINTREE_TAG] },
                    { name: "instance-state-name", values: LIVE_STATES },
                  ],
                  firstPageOnly: true,
                })
              )[0] ?? null
          )
        : null,
    ]);
    const groupId =
      vpcId && verdicts.get("DescribeSecurityGroups") === "allowed"
        ? await optional(async () => {
            const groups = await this.client.describeSecurityGroups(ctx, [
              { name: "vpc-id", values: [vpcId] },
              { name: "group-name", values: ["default"] },
            ]);
            return groups[0]?.groupId ?? null;
          })
        : null;
    const instanceId = instance?.instanceId ?? PROBE_INSTANCE_ID;
    await Promise.all([
      probe("CreateSecurityGroup", [
        ["GroupName", "daintree-permission-check"],
        ["GroupDescription", "Daintree permission check"],
        ...(vpcId ? ([["VpcId", vpcId]] as Array<[string, string]>) : []),
      ]),
      groupId
        ? probe("AuthorizeSecurityGroupIngress", [
            ["GroupId", groupId],
            ["IpPermissions.1.IpProtocol", "tcp"],
            ["IpPermissions.1.FromPort", "22"],
            ["IpPermissions.1.ToPort", "22"],
            ["IpPermissions.1.IpRanges.1.CidrIp", "0.0.0.0/0"],
          ])
        : Promise.resolve(),
      image
        ? probe("RunInstances", [
            ["ImageId", image.imageId],
            ["InstanceType", "t3.medium"],
            ["MinCount", "1"],
            ["MaxCount", "1"],
            // Tagging at launch is its own permission (CreateTags on the new instance).
            ["TagSpecification.1.ResourceType", "instance"],
            ["TagSpecification.1.Tag.1.Key", "daintree"],
            ["TagSpecification.1.Tag.1.Value", "1"],
          ])
        : Promise.resolve(),
      probe("CreateTags", [
        ["ResourceId.1", instanceId],
        ["Tag.1.Key", "Name"],
        ["Tag.1.Value", "daintree-permission-check"],
      ]),
      probe("StartInstances", [["InstanceId.1", instanceId]]),
      probe("StopInstances", [["InstanceId.1", instanceId]]),
      probe("TerminateInstances", [["InstanceId.1", instanceId]]),
    ]);
    return AWS_REQUIRED_ACTIONS.filter((action) => verdicts.get(action) === "denied");
  }

  async validate(credentials: ProviderCredentials): Promise<{ identity: string | null }> {
    const identity = await this.client.callerIdentity(this.ctx(credentials));
    // Replaced keys may sign in to another account than the one this account bills.
    if (identity.account !== credentials.scopeId) {
      throw new AwsApiError(
        "forbidden",
        `These keys belong to AWS account ${identity.account}, not ${credentials.scopeId}`,
        null,
        "AccountMismatch",
        null
      );
    }
    return { identity: awsIdentity(identity.arn) };
  }

  async catalog(credentials: ProviderCredentials): Promise<ProviderCatalog> {
    const ctx = this.ctx(credentials);
    const regions = await this.client.describeRegions(ctx);
    const names = regions.map((region) => region.name).sort();
    const machineTypes: CloudMachineType[] = EC2_INSTANCE_TYPES.map((spec) => ({
      id: spec.id,
      label: ec2InstanceTypeLabel(spec),
      vcpu: spec.vcpu,
      memoryGB: spec.memoryGB,
      // On-demand prices differ by region and only the Pricing API (another permission) has them.
      hourlyDollars: null,
      available: true,
      reason: null,
    }));
    return {
      machineTypes,
      canStart: true,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
      provisioning: {
        location: {
          label: "Region",
          choices: names.map((name) => ({
            id: name,
            label: ec2RegionLabel(name),
            description: null,
            available: true,
            reason: null,
            locations: null,
          })),
          defaultId: names.includes(ctx.region) ? ctx.region : null,
        },
        image: {
          label: "Image",
          choices: EC2_IMAGES.map((image) => ({
            id: image.id,
            label: image.label,
            description: image.description,
            available: true,
            reason: null,
            locations: null,
          })),
          defaultId: DEFAULT_EC2_IMAGE,
        },
      },
    };
  }

  /**
   * The machines Daintree created in the account, in every enabled region:
   * only they run the image, user and key a cloud host connects with, so an
   * instance it didn't create is never offered as one.
   */
  async list(
    credentials: ProviderCredentials,
    options: { label?: string } = {}
  ): Promise<ProviderResource[]> {
    const home = this.ctx(credentials);
    const filters = [
      { name: "instance-state-name", values: LIVE_STATES },
      { name: "tag-key", values: [DAINTREE_TAG] },
    ];
    if (options.label) {
      const eq = options.label.indexOf("=");
      if (eq <= 0) throw new AwsApiError("invalid-request", "Not a label filter", null, null, null);
      filters.push({
        name: `tag:${options.label.slice(0, eq)}`,
        values: [options.label.slice(eq + 1)],
      });
    }
    const regions = await this.client.describeRegions(home);
    const found = await inBatches(regions, REGION_CONCURRENCY, async (region) => {
      const ctx = { ...home, region: region.name };
      const instances = await this.client.describeInstances(ctx, { filters });
      return instances.map((instance) => ec2Resource(region.name, instance));
    });
    return found.flat();
  }

  async inspect(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource> {
    const { region, instanceId } = requireResourceId(resourceId);
    const ctx = this.ctx(credentials, region);
    // EC2 reads are eventually consistent: an instance just launched can be missing for a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        const [instance] = await this.client.describeInstances(ctx, { instanceIds: [instanceId] });
        if (!instance) {
          throw new AwsApiError(
            "not-found",
            "No such instance",
            null,
            "InvalidInstanceID.NotFound",
            null
          );
        }
        return ec2Resource(region, instance);
      } catch (error) {
        if (
          !(error instanceof AwsApiError) ||
          error.kind !== "not-found" ||
          attempt >= NOT_FOUND_RETRIES.length
        ) {
          throw error;
        }
        await this.sleep(NOT_FOUND_RETRIES[attempt]!, ctx.signal);
      }
    }
  }

  async create(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<ProviderResource> {
    const region = request.provisioning.location;
    if (!isAwsRegion(region)) throw invalid("Choose a region for the machine.");
    const imageSpec = ec2Image(request.provisioning.image);
    if (!imageSpec) throw invalid("Choose an image for the machine.");
    const type = ec2InstanceType(request.machineType);
    if (!type) throw invalid(`Daintree doesn't offer the instance type ${request.machineType}.`);
    if (!request.publicKey) throw invalid("There's no SSH key to give the machine.");
    const ctx = this.ctx(credentials, region);
    // A retry of a create whose answer was lost finds what the first send made,
    // even if a newer image has been published since.
    const [existing] = await this.client.describeInstances(ctx, {
      filters: [{ name: "client-token", values: [request.idempotencyKey] }],
    });
    if (existing && ec2MachineState(existing.state) !== "deleted")
      return ec2Resource(region, existing);
    const image = await this.resolveImage(ctx, imageSpec.id, type.architecture);
    const securityGroupId = await this.ensureSecurityGroup(ctx);
    try {
      const instance = await this.client.runInstance(ctx, {
        imageId: image.imageId,
        instanceType: type.id,
        clientToken: request.idempotencyKey,
        securityGroupId,
        userData: ec2UserData(request.publicKey),
        rootDeviceName: image.rootDeviceName ?? "/dev/sda1",
        rootVolumeGiB: EC2_ROOT_VOLUME_GIB,
        tags: { ...request.labels, Name: request.name },
      });
      return ec2Resource(region, instance);
    } catch (error) {
      // The token already launched an instance with other parameters (a newer image since the
      // first send) that the lookup above didn't see yet: it is the one this create made.
      if (!(error instanceof AwsApiError) || error.code !== "IdempotentParameterMismatch")
        throw error;
      for (const wait of [0, ...NOT_FOUND_RETRIES]) {
        if (wait > 0) await this.sleep(wait, ctx.signal);
        const [launched] = await this.client.describeInstances(ctx, {
          filters: [{ name: "client-token", values: [request.idempotencyKey] }],
        });
        if (launched) return ec2Resource(region, launched);
      }
      throw new AwsApiError(
        "server",
        "AWS says this create already launched an instance, and doesn't list it yet",
        null,
        error.code,
        error.requestId
      );
    }
  }

  /** The newest of Canonical's images for the release and architecture in this region. */
  private async resolveImage(
    ctx: AwsRequestContext,
    imageId: string,
    architecture: Ec2Architecture
  ) {
    const spec = ec2Image(imageId);
    if (!spec) throw invalid("Choose an image for the machine.");
    const images = await this.client.describeImages(ctx, {
      owners: [CANONICAL_OWNER_ID],
      filters: [
        { name: "name", values: spec.namePatterns[architecture] },
        { name: "architecture", values: [architecture] },
        { name: "state", values: ["available"] },
      ],
    });
    const newest = images
      .filter((image) => image.architecture === null || image.architecture === architecture)
      .sort((a, b) => (b.creationDate ?? "").localeCompare(a.creationDate ?? ""))[0];
    if (!newest) {
      throw new AwsApiError(
        "not-found",
        `Canonical publishes no ${spec.label} image for ${architecture === "arm64" ? "Arm64" : "x86-64"} in ${ctx.region}`,
        null,
        "InvalidAMIID.NotFound",
        null
      );
    }
    return newest;
  }

  /**
   * The group Daintree's machines join in the region's default VPC, letting
   * SSH in. sshd on Ubuntu's images takes keys only, and this device's address
   * changes as it moves between networks, so the rule doesn't pin one.
   */
  private async ensureSecurityGroup(ctx: AwsRequestContext): Promise<string> {
    const vpcId = await this.client.defaultVpcId(ctx);
    if (!vpcId) {
      throw new AwsApiError(
        "invalid-request",
        `${ctx.region} has no default VPC, which Daintree creates machines in. Create one in the VPC console (Actions → Create default VPC), or choose another region.`,
        null,
        "NoDefaultVpc",
        null
      );
    }
    const find = async () =>
      (
        await this.client.describeSecurityGroups(ctx, [
          { name: "vpc-id", values: [vpcId] },
          { name: "group-name", values: [EC2_SECURITY_GROUP_NAME] },
        ])
      )[0] ?? null;
    let group = await find();
    if (!group) {
      try {
        const groupId = await this.client.createSecurityGroup(ctx, {
          name: EC2_SECURITY_GROUP_NAME,
          description: "SSH to machines Daintree creates",
          vpcId,
          tags: { [DAINTREE_TAG]: "1" },
        });
        group = {
          groupId,
          groupName: EC2_SECURITY_GROUP_NAME,
          vpcId,
          allowsSshFromAnywhere: false,
        };
      } catch (error) {
        // Another device made it first.
        if (!(error instanceof AwsApiError) || error.code !== "InvalidGroup.Duplicate") throw error;
        group = await find();
        if (!group) throw error;
      }
    }
    if (!group.allowsSshFromAnywhere) await this.client.allowSshFromAnywhere(ctx, group.groupId);
    return group.groupId;
  }

  async start(
    credentials: ProviderCredentials,
    resourceId: string,
    _options: { lifetimeSeconds?: number | null }
  ): Promise<ProviderResource | null> {
    const { region, instanceId } = requireResourceId(resourceId);
    const state = await this.client.startInstance(this.ctx(credentials, region), instanceId);
    return this.afterTransition(credentials, resourceId, state);
  }

  async stop(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderResource | null> {
    const { region, instanceId } = requireResourceId(resourceId);
    const state = await this.client.stopInstance(this.ctx(credentials, region), instanceId);
    return this.afterTransition(credentials, resourceId, state);
  }

  /**
   * The machine after a start or stop was accepted, in the state the call
   * reported; null when it can't be read now, which leaves the following to
   * the caller's polling rather than failing an accepted request.
   */
  private async afterTransition(
    credentials: ProviderCredentials,
    resourceId: string,
    state: string | null
  ): Promise<ProviderResource | null> {
    try {
      const resource = await this.inspect(credentials, resourceId);
      if (!state) return resource;
      return { ...resource, machine: ec2MachineState(state), rawState: state };
    } catch (error) {
      if (error instanceof AwsApiError && error.kind === "cancelled") throw error;
      return null;
    }
  }

  async rename(credentials: ProviderCredentials, resourceId: string, name: string): Promise<void> {
    const { region, instanceId } = requireResourceId(resourceId);
    await this.client.createTags(this.ctx(credentials, region), instanceId, { Name: name });
  }

  async delete(credentials: ProviderCredentials, resourceId: string): Promise<void> {
    const { region, instanceId } = requireResourceId(resourceId);
    await this.client.terminateInstance(this.ctx(credentials, region), instanceId);
  }

  async sshAccess(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderSshAccess> {
    const { region, instanceId } = requireResourceId(resourceId);
    const ctx = this.ctx(credentials, region);
    const [instance] = await this.client.describeInstances(ctx, { instanceIds: [instanceId] });
    if (!instance)
      throw new AwsApiError(
        "not-found",
        "No such instance",
        null,
        "InvalidInstanceID.NotFound",
        null
      );
    const endpoint = parseSshEndpoint(instance.publicIp ?? instance.publicDnsName ?? null);
    if (!endpoint) {
      throw new AwsApiError(
        "invalid-request",
        "The instance has no public address to reach it at. Daintree creates machines in a subnet that gives them one.",
        null,
        "NoPublicAddress",
        null
      );
    }
    return { user: EC2_SSH_USER, endpoint, hostKey: await this.consoleHostKey(ctx, instance) };
  }

  /**
   * The host key cloud-init printed to the instance's console, strongest
   * first, or null when it isn't there. Within a few minutes of the first
   * boot it may still be on its way, so it is waited for, briefly; any
   * failure to read the console leaves the person to confirm the key.
   */
  private async consoleHostKey(
    ctx: AwsRequestContext,
    instance: Ec2Instance
  ): Promise<string | null> {
    const startedAt = this.now();
    const createdAt = instance.createdAt ? Date.parse(instance.createdAt) : NaN;
    const fresh = Number.isFinite(createdAt) && startedAt - createdAt < CONSOLE_KEYS_WINDOW_MS;
    let latest = true;
    for (;;) {
      let output: string | null = null;
      try {
        output = await this.client.consoleOutput(ctx, instance.instanceId, latest);
      } catch (error) {
        if (error instanceof AwsApiError && error.kind === "cancelled") throw error;
        // Only Nitro instances keep the latest output; the rest post theirs after a while.
        if (latest && error instanceof AwsApiError && error.code === "UnsupportedOperation") {
          latest = false;
          continue;
        }
        return null;
      }
      const key = output ? consoleHostKeys(output, normalizeHostKey)[0] : undefined;
      if (key) return key;
      const elapsed = this.now() - startedAt;
      if (!fresh || elapsed + CONSOLE_POLL_MS > CONSOLE_KEYS_WAIT_MS) return null;
      if (this.now() - createdAt > CONSOLE_KEYS_WINDOW_MS) return null;
      await this.sleep(CONSOLE_POLL_MS, ctx.signal);
    }
  }

  describeError(error: unknown): CloudHostError {
    const at = Date.now();
    if (!(error instanceof AwsApiError)) {
      return {
        code: "failed",
        message:
          error instanceof AppError && error.userMessage
            ? error.userMessage
            : formatErrorMessage(error, "Something went wrong talking to AWS"),
        at,
      };
    }
    const said = error.message;
    switch (error.kind) {
      case "unauthorized":
        return {
          code: "credential-invalid",
          message:
            error.code === "ExpiredToken" || error.code === "RequestExpired"
              ? "This account's temporary AWS credentials have expired. Replace them in Settings → Hosts."
              : "AWS didn't accept this account's access key. Replace it in Settings → Hosts.",
          at,
        };
      case "forbidden":
        if (error.code === "AccountMismatch")
          return { code: "permission", message: `${said}.`, at };
        return {
          code: "permission",
          message: error.action
            ? `These credentials aren't allowed ec2:${error.action}. Add it to their IAM policy, or use other keys.`
            : `AWS refused: ${said}`,
          at,
        };
      case "billing":
        return {
          code: "billing",
          message: `AWS needs something from the account first: ${said}`,
          at,
        };
      case "rate-limited":
        return {
          code: "rate-limited",
          message: "AWS is limiting requests from this account. Try again shortly.",
          at,
        };
      case "capacity":
        return { code: "capacity", message: `AWS can't run this machine right now: ${said}`, at };
      case "not-found":
        return {
          code: "not-found",
          message:
            error.code === "InvalidAMIID.NotFound"
              ? `${said}.`
              : "AWS doesn't know this machine in this account.",
          at,
        };
      case "network":
      case "timeout":
        return { code: "provider-unreachable", message: "Couldn't reach AWS.", at };
      case "server":
        return { code: "provider-unreachable", message: `AWS had a problem: ${said}`, at };
      case "cancelled":
        return { code: "failed", message: "Cancelled.", at };
      default:
        return { code: "failed", message: said, at };
    }
  }
}
