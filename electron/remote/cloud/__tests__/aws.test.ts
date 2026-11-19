import { describe, expect, it, vi } from "vitest";
import { signAwsRequest } from "../aws/awsSigV4.js";
import { parseXml, xmlItems, xmlTags, xmlText, XmlParseError } from "../aws/awsXml.js";
import {
  AWS_PRODUCTION_API_URL,
  AwsApiError,
  AwsClient,
  awsEndpoint,
  redactAwsText,
  resolveAwsApiUrl,
} from "../aws/AwsClient.js";
import { consoleHostKeys, ec2MachineState, ec2TransitionTime } from "../aws/awsCatalog.js";
import {
  AWS_REQUIRED_ACTIONS,
  AwsProvider,
  awsCredentials,
  awsIdentity,
  ec2UserData,
  parseEc2ResourceId,
} from "../aws/AwsProvider.js";
import { CloudProviderRegistry } from "../CloudProviderRegistry.js";
import { normalizeHostKey } from "../sshEndpoint.js";
import type { ProviderCredentials } from "../provider.js";
import type { MetadataFetch } from "../../host/guestPowerOffSystem.js";
import { cloudMachineHost, IDLE_MINUTES, MINUTE } from "./guestPowerOffHarness.js";

const API = "http://aws.test";
const ACCOUNT = "123456789012";
const VALUES = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-2",
};
const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const ECDSA =
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=";

function xml(body: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { "content-type": "text/xml" },
  });
}

function ec2Error(code: string, message: string, status = 400): Response {
  return xml(
    `<Response><Errors><Error><Code>${code}</Code><Message>${message}</Message></Error></Errors><RequestID>req-1</RequestID></Response>`,
    status
  );
}

interface FakeInstance {
  id: string;
  region: string;
  state: string;
  type: string;
  imageId: string;
  clientToken: string;
  tags: Record<string, string>;
  userData: string;
  createdAt: string;
  publicIp: string | null;
  /** What its own OS shutting down does: `stop` (EC2's default) or `terminate`. */
  shutdownBehavior?: string;
  rootDeviceType?: string;
  lifecycle?: string;
  stateReason?: { code: string; message: string };
}

interface FakeOptions {
  regions?: string[];
  denied?: Set<string>;
  defaultVpc?: boolean;
  console?: (instance: FakeInstance, latest: boolean) => Response | string | null;
  nitro?: boolean;
  /** Which default subnets give an instance a public address: every one (default), the second only, or none. */
  publicSubnets?: "all" | "second" | "none";
  /** A `daintree-ssh` group someone else made, without Daintree's tag. */
  foreignGroup?: boolean;
  /** Regions where DescribeInstances is refused, as a region-limiting policy would. */
  refusedRegions?: string[];
  /** What a DryRun answers instead of its verdict. */
  dryRunAnswer?: () => Response | null;
  /** The newest Ubuntu image's id suffix: a newer image is published by changing it. */
  imageGeneration?: { value: string };
}

/** A fake of the slice of EC2 and STS the provider uses, keyed by the region in the request path. */
function fakeAws(options: FakeOptions = {}) {
  const regions = options.regions ?? ["us-east-2", "eu-west-1"];
  const denied = options.denied ?? new Set<string>();
  const instances: FakeInstance[] = [];
  const groups: Array<{
    id: string;
    name: string;
    vpcId: string;
    ssh: boolean;
    tags: Record<string, string>;
  }> = [];
  const calls: Array<{
    service: string;
    region: string;
    action: string;
    params: URLSearchParams;
    headers: Headers;
    dryRun: boolean;
  }> = [];
  const generation = options.imageGeneration ?? { value: "new" };
  let seq = 0;
  const instanceXml = (instance: FakeInstance) => `<item>
    <instanceId>${instance.id}</instanceId>
    <imageId>${instance.imageId}</imageId>
    <instanceState><code>16</code><name>${instance.state}</name></instanceState>
    <reason>${instance.state === "stopped" ? "User initiated (2026-11-18 01:02:03 GMT)" : ""}</reason>
    <instanceType>${instance.type}</instanceType>
    <launchTime>2026-11-18T00:00:00.000Z</launchTime>
    ${instance.publicIp ? `<ipAddress>${instance.publicIp}</ipAddress>` : ""}
    <architecture>${instance.type.startsWith("t4g") ? "arm64" : "x86_64"}</architecture>
    <rootDeviceName>/dev/sda1</rootDeviceName>
    <rootDeviceType>${instance.rootDeviceType ?? "ebs"}</rootDeviceType>
    ${instance.lifecycle ? `<instanceLifecycle>${instance.lifecycle}</instanceLifecycle>` : ""}
    ${instance.stateReason ? `<stateReason><code>${instance.stateReason.code}</code><message>${instance.stateReason.message}</message></stateReason>` : ""}
    <blockDeviceMapping><item><deviceName>/dev/sda1</deviceName><ebs><volumeId>vol-1</volumeId><status>attached</status><attachTime>${instance.createdAt}</attachTime></ebs></item></blockDeviceMapping>
    <tagSet>${Object.entries(instance.tags)
      .map(([key, value]) => `<item><key>${key}</key><value>${value}</value></item>`)
      .join("")}</tagSet>
  </item>`;
  const filtersOf = (params: URLSearchParams) => {
    const out: Array<{ name: string; values: string[] }> = [];
    for (let i = 1; params.has(`Filter.${i}.Name`); i++) {
      const values: string[] = [];
      for (let j = 1; params.has(`Filter.${i}.Value.${j}`); j++)
        values.push(params.get(`Filter.${i}.Value.${j}`)!);
      out.push({ name: params.get(`Filter.${i}.Name`)!, values });
    }
    return out;
  };
  const tagsOf = (params: URLSearchParams, prefix: string) => {
    const tags: Record<string, string> = {};
    for (let i = 1; params.has(`${prefix}.${i}.Key`); i++) {
      tags[params.get(`${prefix}.${i}.Key`)!] = params.get(`${prefix}.${i}.Value`) ?? "";
    }
    return tags;
  };
  const fetch = async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const [, service, region] = url.pathname.split("/");
    const params = new URLSearchParams(String(init?.body ?? ""));
    const action = params.get("Action")!;
    const headers = new Headers(init?.headers);
    const dryRun = params.get("DryRun") === "true";
    calls.push({ service: service!, region: region!, action, params, headers, dryRun });
    if (!headers.get("authorization")?.includes(`Credential=${VALUES.accessKeyId}/`)) {
      return ec2Error(
        "AuthFailure",
        "AWS was not able to validate the provided access credentials",
        401
      );
    }
    if (service === "sts") {
      return xml(
        `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::${ACCOUNT}:user/dev</Arn><UserId>AIDA</UserId><Account>${ACCOUNT}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`
      );
    }
    if (dryRun) {
      const answer = options.dryRunAnswer?.();
      if (answer) return answer;
      if (denied.has(action)) {
        return ec2Error(
          "UnauthorizedOperation",
          "You are not authorized to perform this operation. Encoded authorization failure message: abc123",
          403
        );
      }
      return ec2Error(
        "DryRunOperation",
        "Request would have succeeded, but DryRun flag is set.",
        412
      );
    }
    if (denied.has(action))
      return ec2Error(
        "UnauthorizedOperation",
        "You are not authorized to perform this operation.",
        403
      );
    const here = instances.filter((instance) => instance.region === region);
    switch (action) {
      case "DescribeRegions":
        return xml(
          `<DescribeRegionsResponse><regionInfo>${regions
            .map(
              (name) =>
                `<item><regionName>${name}</regionName><regionEndpoint>ec2.${name}.amazonaws.com</regionEndpoint><optInStatus>opt-in-not-required</optInStatus></item>`
            )
            .join("")}</regionInfo></DescribeRegionsResponse>`
        );
      case "DescribeInstances": {
        if (options.refusedRegions?.includes(region!)) {
          return ec2Error(
            "UnauthorizedOperation",
            "You are not authorized to perform this operation.",
            403
          );
        }
        let found = here;
        if (params.has("InstanceId.1")) {
          const id = params.get("InstanceId.1")!;
          found = here.filter((instance) => instance.id === id);
          if (found.length === 0)
            return ec2Error("InvalidInstanceID.NotFound", `The instance ID '${id}' does not exist`);
        }
        for (const filter of filtersOf(params)) {
          found = found.filter((instance) => {
            if (filter.name === "instance-state-name")
              return filter.values.includes(instance.state);
            if (filter.name === "client-token") return filter.values.includes(instance.clientToken);
            if (filter.name.startsWith("tag:"))
              return filter.values.includes(instance.tags[filter.name.slice(4)] ?? "");
            if (filter.name === "tag-key") return filter.values.some((key) => key in instance.tags);
            return true;
          });
        }
        return xml(
          `<DescribeInstancesResponse><reservationSet>${found
            .map(
              (instance) =>
                `<item><reservationId>r-1</reservationId><instancesSet>${instanceXml(instance)}</instancesSet></item>`
            )
            .join("")}</reservationSet></DescribeInstancesResponse>`
        );
      }
      case "DescribeImages": {
        // Only Canonical's own images, matched by name the way EC2 matches a wildcard filter.
        if (params.get("Owner.1") !== "099720109477") {
          return xml("<DescribeImagesResponse><imagesSet/></DescribeImagesResponse>");
        }
        const filters = filtersOf(params);
        const arch =
          filters.find((filter) => filter.name === "architecture")?.values[0] ?? "x86_64";
        const names = filters.find((filter) => filter.name === "name")?.values ?? [];
        const debArch = arch === "arm64" ? "arm64" : "amd64";
        const release = names.some((name) => name.includes(`ubuntu-noble-24.04-${debArch}-server-`))
          ? "noble"
          : names.some((name) => name.includes(`ubuntu-jammy-22.04-${debArch}-server-`))
            ? "jammy"
            : null;
        if (!release) return xml("<DescribeImagesResponse><imagesSet/></DescribeImagesResponse>");
        return xml(
          `<DescribeImagesResponse><imagesSet>
            <item><imageId>ami-${release}-${arch}-old</imageId><name>ubuntu-${release}-old</name><architecture>${arch}</architecture><creationDate>2026-01-01T00:00:00.000Z</creationDate><rootDeviceName>/dev/sda1</rootDeviceName></item>
            <item><imageId>ami-${release}-${arch}-${generation.value}</imageId><name>ubuntu-${release}-new</name><architecture>${arch}</architecture><creationDate>2026-11-01T00:00:00.000Z</creationDate><rootDeviceName>/dev/sda1</rootDeviceName></item>
          </imagesSet></DescribeImagesResponse>`
        );
      }
      case "DescribeSubnets": {
        const mode = options.publicSubnets ?? "all";
        const subnets = ["a", "b"].map((zone, i) => ({
          id: `subnet-${region}${zone}`,
          zone: `${region}${zone}`,
          maps: mode === "all" || (mode === "second" && i === 1),
        }));
        return xml(
          `<DescribeSubnetsResponse><subnetSet>${subnets
            .map(
              (subnet) =>
                `<item><subnetId>${subnet.id}</subnetId><availabilityZone>${subnet.zone}</availabilityZone><defaultForAz>true</defaultForAz><mapPublicIpOnLaunch>${subnet.maps}</mapPublicIpOnLaunch></item>`
            )
            .join("")}</subnetSet></DescribeSubnetsResponse>`
        );
      }
      case "DescribeVpcs":
        return xml(
          `<DescribeVpcsResponse><vpcSet>${options.defaultVpc === false ? "" : `<item><vpcId>vpc-${region}</vpcId><isDefault>true</isDefault></item>`}</vpcSet></DescribeVpcsResponse>`
        );
      case "DescribeSecurityGroups": {
        const filters = filtersOf(params);
        const names = filters.find((filter) => filter.name === "group-name")?.values ?? [];
        const vpc = filters.find((filter) => filter.name === "vpc-id")?.values[0];
        const all = [
          ...groups,
          {
            id: `sg-default-${region}`,
            name: "default",
            vpcId: `vpc-${region}`,
            ssh: false,
            tags: {},
          },
          ...(options.foreignGroup
            ? [
                {
                  id: `sg-office-${region}`,
                  name: "daintree-ssh",
                  vpcId: `vpc-${region}`,
                  ssh: false,
                  tags: { team: "office" } as Record<string, string>,
                },
              ]
            : []),
        ];
        const found = all.filter((group) => names.includes(group.name) && group.vpcId === vpc);
        return xml(
          `<DescribeSecurityGroupsResponse><securityGroupInfo>${found
            .map(
              (group) =>
                `<item><groupId>${group.id}</groupId><groupName>${group.name}</groupName><vpcId>${group.vpcId}</vpcId><ipPermissions>${group.ssh ? "<item><ipProtocol>tcp</ipProtocol><fromPort>22</fromPort><toPort>22</toPort><ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges></item>" : ""}</ipPermissions><tagSet>${Object.entries(
                  group.tags
                )
                  .map(([key, value]) => `<item><key>${key}</key><value>${value}</value></item>`)
                  .join("")}</tagSet></item>`
            )
            .join("")}</securityGroupInfo></DescribeSecurityGroupsResponse>`
        );
      }
      case "CreateSecurityGroup": {
        const id = `sg-${++seq}`;
        groups.push({
          id,
          name: params.get("GroupName")!,
          vpcId: params.get("VpcId")!,
          ssh: false,
          tags: tagsOf(params, "TagSpecification.1.Tag"),
        });
        return xml(
          `<CreateSecurityGroupResponse><return>true</return><groupId>${id}</groupId></CreateSecurityGroupResponse>`
        );
      }
      case "AuthorizeSecurityGroupIngress": {
        const group = groups.find((entry) => entry.id === params.get("GroupId"));
        const rule = [
          params.get("IpPermissions.1.IpProtocol"),
          params.get("IpPermissions.1.FromPort"),
          params.get("IpPermissions.1.ToPort"),
          params.get("IpPermissions.1.IpRanges.1.CidrIp"),
        ].join(" ");
        // Only the rule this fake models as "SSH from anywhere" counts as one.
        if (rule !== "tcp 22 22 0.0.0.0/0")
          return ec2Error("InvalidParameterValue", `rule ${rule}`);
        if (group?.ssh)
          return ec2Error("InvalidPermission.Duplicate", "the specified rule already exists");
        if (group) group.ssh = true;
        return xml(
          `<AuthorizeSecurityGroupIngressResponse><return>true</return></AuthorizeSecurityGroupIngressResponse>`
        );
      }
      case "RunInstances": {
        const token = params.get("ClientToken")!;
        let instance = here.find((entry) => entry.clientToken === token);
        if (
          instance &&
          (instance.imageId !== params.get("ImageId") ||
            instance.type !== params.get("InstanceType"))
        ) {
          return ec2Error(
            "IdempotentParameterMismatch",
            "Arguments on this idempotent request are inconsistent with arguments used in previous request(s)."
          );
        }
        if (!instance) {
          instance = {
            id: `i-0abc${String(++seq).padStart(13, "0")}`,
            region: region!,
            state: "pending",
            type: params.get("InstanceType")!,
            imageId: params.get("ImageId")!,
            clientToken: token,
            tags: tagsOf(params, "TagSpecification.1.Tag"),
            userData: Buffer.from(params.get("UserData") ?? "", "base64").toString("utf8"),
            createdAt: new Date(Date.now()).toISOString(),
            publicIp: "203.0.113.20",
            shutdownBehavior: params.get("InstanceInitiatedShutdownBehavior") ?? "stop",
          };
          instances.push(instance);
        }
        return xml(
          `<RunInstancesResponse><reservationId>r-1</reservationId><instancesSet>${instanceXml(instance)}</instancesSet></RunInstancesResponse>`
        );
      }
      case "StartInstances":
      case "StopInstances":
      case "TerminateInstances": {
        const instance = here.find((entry) => entry.id === params.get("InstanceId.1"));
        if (!instance) return ec2Error("InvalidInstanceID.NotFound", "does not exist");
        if (action === "StartInstances" && instance.state !== "stopped") {
          return ec2Error(
            "IncorrectInstanceState",
            `The instance '${instance.id}' is not in a state from which it can be started.`
          );
        }
        const next =
          action === "StartInstances"
            ? "pending"
            : action === "StopInstances"
              ? "stopping"
              : "shutting-down";
        instance.state = next;
        const tag = action.replace("Instances", "InstancesResponse");
        return xml(
          `<${tag}><instancesSet><item><instanceId>${instance.id}</instanceId><currentState><code>0</code><name>${next}</name></currentState></item></instancesSet></${tag}>`
        );
      }
      case "DescribeInstanceAttribute": {
        const instance = here.find((entry) => entry.id === params.get("InstanceId"));
        if (!instance) return ec2Error("InvalidInstanceID.NotFound", "does not exist");
        if (params.get("Attribute") !== "instanceInitiatedShutdownBehavior") {
          return ec2Error("InvalidParameterValue", "attribute");
        }
        return xml(
          `<DescribeInstanceAttributeResponse><requestId>req-1</requestId><instanceId>${instance.id}</instanceId><instanceInitiatedShutdownBehavior><value>${instance.shutdownBehavior ?? "stop"}</value></instanceInitiatedShutdownBehavior></DescribeInstanceAttributeResponse>`
        );
      }
      case "CreateTags": {
        const instance = here.find((entry) => entry.id === params.get("ResourceId.1"));
        if (instance) Object.assign(instance.tags, tagsOf(params, "Tag"));
        return xml(`<CreateTagsResponse><return>true</return></CreateTagsResponse>`);
      }
      case "GetConsoleOutput": {
        const instance = here.find((entry) => entry.id === params.get("InstanceId"))!;
        const latest = params.get("Latest") === "true";
        if (latest && options.nitro === false) {
          return ec2Error(
            "UnsupportedOperation",
            "This instance type does not support retrieving the latest console logs."
          );
        }
        const result = options.console?.(instance, latest) ?? null;
        if (result instanceof Response) return result;
        return xml(
          `<GetConsoleOutputResponse><instanceId>${instance.id}</instanceId><timestamp>2026-11-18T00:01:00Z</timestamp>${result === null ? "" : `<output>${Buffer.from(result).toString("base64")}</output>`}</GetConsoleOutputResponse>`
        );
      }
      default:
        return ec2Error("InvalidAction", `Unknown action ${action}`);
    }
  };
  /** The instance's own OS powering off, as EC2 then handles it: no API call is involved. */
  const guestPowerOff = (id: string) => {
    const instance = instances.find((entry) => entry.id === id)!;
    if (instance.shutdownBehavior === "terminate") {
      instance.state = "terminated";
      instance.stateReason = {
        code: "Client.InstanceInitiatedShutdown",
        message: "Client.InstanceInitiatedShutdown: Instance initiated shutdown",
      };
    } else {
      instance.state = "stopped";
      instance.stateReason = {
        code: "Client.InstanceInitiatedShutdown",
        message: "Client.InstanceInitiatedShutdown: Instance initiated shutdown",
      };
    }
  };
  /** The instance's metadata server (IMDSv2), answering only from the instance itself. */
  const metadataFor =
    (id: string): MetadataFetch =>
    async (request) => {
      const instance = instances.find((entry) => entry.id === id)!;
      if (
        request.method === "PUT" &&
        request.path === "/latest/api/token" &&
        request.headers["X-aws-ec2-metadata-token-ttl-seconds"]
      ) {
        return { status: 200, headers: {}, body: "imds-token" };
      }
      if (
        request.path === "/latest/dynamic/instance-identity/document" &&
        request.headers["X-aws-ec2-metadata-token"] === "imds-token"
      ) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            accountId: ACCOUNT,
            region: instance.region,
            instanceId: instance.id,
            architecture: "x86_64",
          }),
        };
      }
      return { status: 401, headers: {}, body: "" };
    };
  return { fetch, calls, instances, groups, generation, guestPowerOff, metadataFor };
}

function setup(options: FakeOptions = {}) {
  const fake = fakeAws(options);
  const client = new AwsClient({ fetch: fake.fetch as typeof fetch, sleep: async () => {} });
  let now = Date.now();
  const provider = new AwsProvider({
    client,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const credentials: ProviderCredentials = { values: VALUES, scopeId: ACCOUNT, apiUrl: API };
  return { fake, client, provider, credentials, advance: (ms: number) => (now += ms) };
}

const CREATE = {
  name: "Build box",
  machineType: "t3.large",
  lifetimeSeconds: null,
  provisioning: { location: "eu-west-1", image: "ubuntu-24.04", network: null },
  labels: { daintree: "1", "daintree-binding": "bind-1" },
  idempotencyKey: "4f9a3c1e-0d2b-4c8e-9a71-1f2e3d4c5b6a",
  publicKey: `${ED25519} daintree: key #1`,
};

describe("signAwsRequest", () => {
  const credentials = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    sessionToken: null,
  };
  const now = new Date("2015-08-30T12:36:00Z");

  it("matches AWS's published IAM ListUsers example", () => {
    const headers = signAwsRequest({
      method: "GET",
      url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      service: "iam",
      region: "us-east-1",
      credentials,
      now,
    });
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
    );
  });

  it("matches the SigV4 suite's get-vanilla case", () => {
    const headers = signAwsRequest({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      body: "",
      service: "service",
      region: "us-east-1",
      credentials,
      now,
    });
    expect(headers.Authorization).toContain(
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
    );
  });

  it("signs a session token as a header and never returns the secret", () => {
    const headers = signAwsRequest({
      method: "POST",
      url: new URL("https://ec2.us-east-2.amazonaws.com/"),
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "Action=DescribeRegions&Version=2016-11-15",
      service: "ec2",
      region: "us-east-2",
      credentials: { ...credentials, sessionToken: "FwoGZXIvYXdzEXAMPLETOKEN" },
      now,
    });
    expect(headers["x-amz-security-token"]).toBe("FwoGZXIvYXdzEXAMPLETOKEN");
    expect(headers.Authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token"
    );
    expect(JSON.stringify(headers)).not.toContain(credentials.secretAccessKey);
  });

  it("signs a Query POST's body, port, path and session token as aws4 does", () => {
    // Computed with the aws4 package for the same request.
    const body =
      "Action=DescribeInstances&Version=2016-11-15&Filter.1.Name=tag%3Adaintree-binding&Filter.1.Value.1=abc";
    const headers = signAwsRequest({
      method: "POST",
      url: new URL("http://127.0.0.1:4567/aws/ec2/us-east-2/"),
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
      service: "ec2",
      region: "us-east-2",
      credentials: { ...credentials, sessionToken: "FwoGZXIvYXdzEXAMPLETOKEN" },
      now: new Date("2026-11-18T01:02:03Z"),
    });
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261118/us-east-2/ec2/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-date;x-amz-security-token, Signature=b379626466d6e1b1e7b553a4ec8be184a945d4b6c65c4158b4a4303634bda5e9"
    );
  });
});

describe("parseXml", () => {
  it("reads elements, entities, CDATA and namespaced names", () => {
    const root = parseXml(
      `<?xml version="1.0"?><!-- note --><a:Root xmlns:a="x"><Name>R&amp;D &lt;1&gt; &#x41;&#66;</Name><Raw><![CDATA[<b>]]></Raw><tagSet><item><key>Name</key><value>box</value></item><item><key>constructor</key><value>x</value></item></tagSet><Empty/></a:Root>`
    );
    expect(root.name).toBe("Root");
    expect(xmlText(root, "Name")).toBe("R&D <1> AB");
    expect(xmlText(root, "Raw")).toBe("<b>");
    expect(xmlTags(root)).toEqual({ Name: "box" });
    expect(xmlText(root, "Empty")).toBeNull();
    expect(xmlItems(root, "missing")).toEqual([]);
  });

  it("refuses what isn't well formed", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(XmlParseError);
    expect(() => parseXml("<a>")).toThrow(XmlParseError);
    expect(() => parseXml("<!DOCTYPE x><a/>")).toThrow(XmlParseError);
    expect(() => parseXml("<a/><b/>")).toThrow(XmlParseError);
  });
});

describe("endpoints", () => {
  it("uses each region's own endpoint in production and a path under an override", () => {
    expect(String(awsEndpoint(AWS_PRODUCTION_API_URL, "ec2", "eu-west-1"))).toBe(
      "https://ec2.eu-west-1.amazonaws.com/"
    );
    expect(String(awsEndpoint("http://127.0.0.1:9/aws", "sts", "us-east-2"))).toBe(
      "http://127.0.0.1:9/aws/sts/us-east-2/"
    );
    expect(() => awsEndpoint(AWS_PRODUCTION_API_URL, "ec2", "evil.com/x")).toThrow(AwsApiError);
    // Other partitions live under other domains, with other image owners.
    expect(() => awsEndpoint(AWS_PRODUCTION_API_URL, "sts", "cn-north-1")).toThrow(AwsApiError);
    expect(() => awsEndpoint(AWS_PRODUCTION_API_URL, "ec2", "us-gov-west-1")).toThrow(AwsApiError);
  });

  it("honours an override only in a development build", () => {
    expect(resolveAwsApiUrl(true, { DAINTREE_AWS_API_URL: "http://127.0.0.1:9" })).toBe(
      AWS_PRODUCTION_API_URL
    );
    expect(resolveAwsApiUrl(false, { DAINTREE_AWS_API_URL: "http://127.0.0.1:9/aws/?q=1" })).toBe(
      "http://127.0.0.1:9/aws"
    );
    expect(resolveAwsApiUrl(false, { DAINTREE_AWS_API_URL: "file:///etc" })).toBe(
      AWS_PRODUCTION_API_URL
    );
    expect(resolveAwsApiUrl(false, {})).toBe(AWS_PRODUCTION_API_URL);
  });
});

describe("AwsClient", () => {
  const ctx = {
    credentials: {
      accessKeyId: VALUES.accessKeyId,
      secretAccessKey: VALUES.secretAccessKey,
      sessionToken: null,
    },
    apiUrl: API,
    region: "us-east-2",
  };

  function clientWith(responses: Array<Response | Error | ((body: URLSearchParams) => Response)>) {
    const seen: string[] = [];
    const client = new AwsClient({
      fetch: (async (_url: URL | string, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body));
        seen.push(body.get("Action")!);
        const queued = responses.shift();
        const next = typeof queued === "function" ? queued(body) : queued;
        if (!next) throw new Error("no response queued");
        if (next instanceof Error) throw next;
        return next;
      }) as typeof fetch,
      sleep: async () => {},
    });
    return { client, seen };
  }

  it("types EC2 and STS error envelopes by code", async () => {
    const { client } = clientWith([
      ec2Error(
        "UnauthorizedOperation",
        "You are not authorized. Encoded authorization failure message: zzz",
        403
      ),
      xml(
        `<ErrorResponse><Error><Type>Sender</Type><Code>InvalidClientTokenId</Code><Message>The security token included in the request is invalid.</Message></Error><RequestId>r</RequestId></ErrorResponse>`,
        403
      ),
    ]);
    const refused = await client.describeRegions(ctx).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      kind: "forbidden",
      code: "UnauthorizedOperation",
      action: "DescribeRegions",
    });
    expect((refused as Error).message).not.toContain("Encoded");
    await expect(client.callerIdentity(ctx)).rejects.toMatchObject({
      kind: "unauthorized",
      code: "InvalidClientTokenId",
    });
  });

  it("retries a throttled read and gives up on a refusal at once", async () => {
    const throttled = clientWith([
      ec2Error("RequestLimitExceeded", "Request limit exceeded.", 503),
      xml(
        `<DescribeRegionsResponse><regionInfo><item><regionName>us-east-2</regionName></item></regionInfo></DescribeRegionsResponse>`
      ),
    ]);
    expect(await throttled.client.describeRegions(ctx)).toEqual([
      { name: "us-east-2", optInStatus: null },
    ]);
    expect(throttled.seen).toEqual(["DescribeRegions", "DescribeRegions"]);

    const refused = clientWith([ec2Error("UnauthorizedOperation", "no", 403), ec2Error("X", "y")]);
    await expect(refused.client.describeRegions(ctx)).rejects.toMatchObject({ kind: "forbidden" });
    expect(refused.seen).toEqual(["DescribeRegions"]);
  });

  it("sends an idle stop once, where a person's stop retries a throttled send (#17924)", async () => {
    const idle = clientWith([
      ec2Error("RequestLimitExceeded", "Request limit exceeded.", 503),
      ec2Error("X", "never sent"),
    ]);
    await expect(
      idle.client.stopInstance(ctx, "i-0aaaaaaaaaaaaaaa1", { once: true })
    ).rejects.toMatchObject({ kind: "rate-limited" });
    expect(idle.seen).toEqual(["StopInstances"]);

    const person = clientWith([
      ec2Error("RequestLimitExceeded", "Request limit exceeded.", 503),
      xml(
        `<StopInstancesResponse><instancesSet><item><currentState><name>stopping</name></currentState></item></instancesSet></StopInstancesResponse>`
      ),
    ]);
    await expect(person.client.stopInstance(ctx, "i-0aaaaaaaaaaaaaaa1")).resolves.toBe("stopping");
    expect(person.seen).toEqual(["StopInstances", "StopInstances"]);
  });

  it("keeps a mutation's lost answer unknown when its resend is refused", async () => {
    const { client, seen } = clientWith([
      new TypeError("socket hang up"),
      ec2Error("RequestLimitExceeded", "Request limit exceeded.", 503),
      ec2Error("RequestLimitExceeded", "Request limit exceeded.", 503),
    ]);
    const failed = await client.startInstance(ctx, "i-0aaaaaaaaaaaaaaa1").catch((e: unknown) => e);
    expect(seen).toHaveLength(3);
    // The first send may have started it: a later throttling proves nothing about that.
    expect(failed).toMatchObject({ kind: "network" });
    expect((failed as AwsApiError).outcomeUnknown).toBe(true);
  });

  it("reads a 503 with no code as AWS failing, not as throttling", async () => {
    const { client } = clientWith([
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    ]);
    await expect(client.describeRegions(ctx)).rejects.toMatchObject({ kind: "server" });
  });

  it("stops reading an answer that outgrows the limit", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const { client } = clientWith([new Response(endless, { status: 200 })]);
    await expect(client.describeRegions(ctx)).rejects.toMatchObject({ kind: "bad-response" });
    expect(sent).toBeLessThan(10);
  });

  it("follows NextToken and reads the first launch from the root volume", async () => {
    const page = (id: string, token: string | null) =>
      xml(
        `<DescribeInstancesResponse><reservationSet><item><instancesSet><item><instanceId>${id}</instanceId><instanceState><name>running</name></instanceState><launchTime>2026-11-18T09:00:00.000Z</launchTime><rootDeviceName>/dev/xvda</rootDeviceName><blockDeviceMapping><item><deviceName>/dev/sdf</deviceName><ebs><attachTime>2026-11-18T08:00:00.000Z</attachTime></ebs></item><item><deviceName>/dev/xvda</deviceName><ebs><attachTime>2026-11-01T00:00:00.000Z</attachTime></ebs></item></blockDeviceMapping></item></instancesSet></item></reservationSet>${token ? `<nextToken>${token}</nextToken>` : ""}</DescribeInstancesResponse>`
      );
    const { client } = clientWith([
      page("i-0aaaaaaaaaaaaaaa1", "t2"),
      // Page two only for the token page one handed out.
      (body) =>
        body.get("NextToken") === "t2"
          ? page("i-0aaaaaaaaaaaaaaa2", null)
          : ec2Error("InvalidParameterValue", "bad token"),
    ]);
    const found = await client.describeInstances(ctx, { filters: [] });
    expect(found.map((instance) => instance.instanceId)).toEqual([
      "i-0aaaaaaaaaaaaaaa1",
      "i-0aaaaaaaaaaaaaaa2",
    ]);
    expect(found[0]!.createdAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("reads DryRun's verdicts, and only from a request that carried the flag", async () => {
    const verdict = (response: Response) => (body: URLSearchParams) =>
      body.get("DryRun") === "true" ? response : xml("<StopInstancesResponse/>");
    const { client } = clientWith([
      verdict(
        ec2Error("DryRunOperation", "Request would have succeeded, but DryRun flag is set.", 412)
      ),
      verdict(ec2Error("UnauthorizedOperation", "no", 403)),
      verdict(ec2Error("AccessDenied", "no", 403)),
      verdict(ec2Error("InvalidInstanceID.NotFound", "no such instance")),
    ]);
    expect(await client.dryRun(ctx, "StopInstances", [])).toBe("allowed");
    expect(await client.dryRun(ctx, "StopInstances", [])).toBe("denied");
    expect(await client.dryRun(ctx, "StopInstances", [])).toBe("denied");
    expect(await client.dryRun(ctx, "StopInstances", [])).toBe("unknown");
  });

  it("gives no verdict when the answer never came, or when the call ran instead", async () => {
    const unreachable = clientWith([new TypeError("x"), new TypeError("x"), new TypeError("x")]);
    await expect(unreachable.client.dryRun(ctx, "StopInstances", [])).rejects.toMatchObject({
      kind: "network",
    });
    const ran = clientWith([xml("<StopInstancesResponse/>")]);
    await expect(ran.client.dryRun(ctx, "StopInstances", [])).rejects.toMatchObject({
      kind: "bad-response",
    });
  });

  it("redacts credentials from AWS's words", () => {
    const text = redactAwsText(
      `Key ${VALUES.accessKeyId} secret ${VALUES.secretAccessKey} other ASIAEXAMPLEEXAMPLE12 Encoded authorization failure message: abc`,
      { ...ctx.credentials }
    );
    expect(text).not.toContain(VALUES.accessKeyId);
    expect(text).not.toContain(VALUES.secretAccessKey);
    expect(text).not.toContain("ASIAEXAMPLE");
    expect(text).not.toContain("abc");
  });
});

describe("EC2 helpers", () => {
  it("maps instance states", () => {
    expect(ec2MachineState("pending")).toBe("starting");
    expect(ec2MachineState("running")).toBe("running");
    expect(ec2MachineState("stopping")).toBe("stopping");
    expect(ec2MachineState("stopped")).toBe("stopped");
    expect(ec2MachineState("shutting-down")).toBe("deleted");
    expect(ec2MachineState("terminated")).toBe("deleted");
    expect(ec2MachineState("weird")).toBe("unknown");
  });

  it("reads cloud-init's host key block from the console, strongest first", () => {
    const output = [
      "[   12.3] cloud-init[812]: Cloud-init v. 24.1 running 'modules:final'",
      "-----BEGIN SSH HOST KEY KEYS-----",
      `${ECDSA} root@ip-10-0-0-1`,
      `${ED25519} root@ip-10-0-0-1`,
      "-----END SSH HOST KEY KEYS-----",
    ].join("\r\n");
    expect(consoleHostKeys(output, normalizeHostKey)).toEqual([ED25519, ECDSA]);
    // A block the console hasn't finished printing isn't read, even with a whole key in it.
    expect(
      consoleHostKeys(`-----BEGIN SSH HOST KEY KEYS-----\n${ED25519} root@x\n`, normalizeHostKey)
    ).toEqual([]);
    expect(consoleHostKeys("booting", normalizeHostKey)).toEqual([]);
  });

  it("reads when a stop happened from its transition reason", () => {
    expect(ec2TransitionTime("User initiated (2026-11-18 01:02:03 GMT)")).toBe(
      "2026-11-18T01:02:03.000Z"
    );
    expect(ec2TransitionTime(null)).toBeNull();
  });

  it("checks the entered credentials' shape", () => {
    expect(awsCredentials({ ...VALUES, region: "US-EAST-2" }).region).toBe("us-east-2");
    expect(() => awsCredentials({ ...VALUES, region: "mars" })).toThrow(/region/);
    expect(() => awsCredentials({ ...VALUES, region: "cn-north-1" })).toThrow(/China, GovCloud/);
    expect(() => awsCredentials({ ...VALUES, accessKeyId: "ASIAIOSFODNN7EXAMPLE" })).toThrow(
      /session token/
    );
    expect(() => awsCredentials({ ...VALUES, secretAccessKey: "short" })).toThrow(
      /secret access key/
    );
  });

  it("puts only a one-line public key into user data", () => {
    expect(ec2UserData(`${ED25519} me: #1`)).toBe(
      `#cloud-config\nssh_authorized_keys:\n  - "${ED25519} me: #1"\n`
    );
    expect(() => ec2UserData("-----BEGIN OPENSSH PRIVATE KEY-----")).toThrow();
    expect(() => ec2UserData(`${ED25519}\nevil`)).toThrow();
  });

  it("keeps an assumed role's identity across its sessions", () => {
    expect(awsIdentity(`arn:aws:sts::${ACCOUNT}:assumed-role/Dev/alice@example.com`)).toBe(
      `arn:aws:sts::${ACCOUNT}:assumed-role/Dev`
    );
    expect(awsIdentity(`arn:aws:iam::${ACCOUNT}:user/dev`)).toBe(
      `arn:aws:iam::${ACCOUNT}:user/dev`
    );
  });

  it("names the region in a resource id", () => {
    expect(parseEc2ResourceId("eu-west-1/i-0abc0000000000001")).toEqual({
      region: "eu-west-1",
      instanceId: "i-0abc0000000000001",
    });
    expect(parseEc2ResourceId("i-0abc0000000000001")).toBeNull();
    expect(parseEc2ResourceId("eu-west-1/vol-1")).toBeNull();
  });
});

describe("AwsProvider", () => {
  it("registers as a built-in with a declaration the registry accepts", () => {
    const { provider } = setup();
    const registry = new CloudProviderRegistry();
    registry.register(provider, { owner: { kind: "built-in" }, apiUrl: API });
    const info = provider.info("darwin");
    expect(info.capabilities).toMatchObject({
      lifetime: { kind: "none" },
      sshTrust: "api-or-confirm",
      provisioning: {
        location: "required",
        image: "required",
        network: "none",
        sshKey: "at-create",
      },
      persistence: { stoppedComputeBilled: false, stoppedStorageBilled: true, retentionDays: null },
      deletion: true,
    });
    expect(info.credentialFields.map((field) => [field.id, field.required])).toEqual([
      ["accessKeyId", true],
      ["secretAccessKey", true],
      ["sessionToken", false],
      ["region", true],
    ]);
    expect(provider.info("win32").unsupportedReason).not.toBeNull();
  });

  const MUTATIONS = new Set([
    "RunInstances",
    "StartInstances",
    "StopInstances",
    "TerminateInstances",
    "CreateTags",
    "CreateSecurityGroup",
    "AuthorizeSecurityGroupIngress",
  ]);

  it("connects credentials that can do everything, as their AWS account, changing nothing", async () => {
    const { provider, fake } = setup();
    await expect(provider.checkCredentials(VALUES, API)).resolves.toEqual({
      identity: `arn:aws:iam::${ACCOUNT}:user/dev`,
      scopes: [
        { scope: { kind: "account", id: ACCOUNT, name: `AWS account ${ACCOUNT}` }, active: true },
      ],
    });
    const asked = fake.calls.filter((call) => MUTATIONS.has(call.action));
    expect(new Set(asked.map((call) => call.action))).toEqual(MUTATIONS);
    expect(asked.every((call) => call.dryRun)).toBe(true);
  });

  it("names each permission the credentials are missing", async () => {
    for (const action of AWS_REQUIRED_ACTIONS) {
      const { provider } = setup({ denied: new Set([action]) });
      const refused = await provider.checkCredentials(VALUES, API).catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "PERMISSION" });
      expect((refused as { userMessage: string }).userMessage).toContain(`Missing: ec2:${action}.`);
    }
    const { provider } = setup({ denied: new Set(["RunInstances", "TerminateInstances"]) });
    const refused = await provider.checkCredentials(VALUES, API).catch((error: unknown) => error);
    expect((refused as { userMessage: string }).userMessage).toContain(
      "Missing: ec2:RunInstances, ec2:TerminateInstances."
    );
  });

  it("asks about each permission the way Daintree's own requests use it", async () => {
    const { provider, credentials, fake } = setup();
    // A Daintree group in the home region: the probes name it rather than the default group.
    await provider.create(credentials, {
      ...CREATE,
      provisioning: { ...CREATE.provisioning, location: "us-east-2" },
    });
    fake.calls.length = 0;
    await provider.checkCredentials(VALUES, API);
    const probe = (action: string) =>
      fake.calls.find((call) => call.action === action && call.dryRun)!.params;
    const run = probe("RunInstances");
    expect(run.get("ImageId")).toBe("ami-noble-x86_64-new");
    expect(run.get("SecurityGroupId.1")).toBe("sg-1");
    expect(run.get("TagSpecification.2.ResourceType")).toBe("volume");
    expect(probe("AuthorizeSecurityGroupIngress").get("GroupId")).toBe("sg-1");
    expect(probe("CreateSecurityGroup").get("TagSpecification.1.ResourceType")).toBe(
      "security-group"
    );
    expect(probe("StopInstances").get("InstanceId.1")).toBe(fake.instances[0]!.id);
  });

  it("names no stand-in group, and carries a create's tag keys, when nothing of Daintree's exists", async () => {
    const { provider, fake } = setup();
    await provider.checkCredentials(VALUES, API);
    const probe = (action: string) =>
      fake.calls.find((call) => call.action === action && call.dryRun)!.params;
    expect(probe("AuthorizeSecurityGroupIngress").get("GroupId")).toBe("sg-0000000000000000d");
    expect(probe("RunInstances").has("SecurityGroupId.1")).toBe(false);
    const keys = [...probe("RunInstances").entries()]
      .filter(([key]) => /^TagSpecification\.1\.Tag\.\d+\.Key$/.test(key))
      .map(([, value]) => value);
    expect(keys).toEqual(expect.arrayContaining(["daintree", "daintree-binding"]));
  });

  it("fails the check when AWS can't be asked, rather than passing it unverified", async () => {
    const { provider } = setup({
      dryRunAnswer: () => new Response("", { status: 500 }),
    });
    const refused = await provider.checkCredentials(VALUES, API).catch((error: unknown) => error);
    expect(provider.describeError(refused)).toMatchObject({ code: "provider-unreachable" });
  });

  it("refuses credentials AWS doesn't accept", async () => {
    const { provider } = setup();
    const refused = await provider
      .checkCredentials({ ...VALUES, accessKeyId: "AKIAOTHERKEYEXAMPLE1" }, API)
      .catch((error: unknown) => error);
    expect(provider.describeError(refused)).toMatchObject({ code: "credential-invalid" });
  });

  it("refuses replaced keys that belong to another AWS account", async () => {
    const { provider, credentials } = setup();
    const refused = await provider
      .validate({ ...credentials, scopeId: "999999999999" })
      .catch((error: unknown) => error);
    expect(provider.describeError(refused)).toMatchObject({ code: "permission" });
  });

  it("offers the enabled regions, defaulting to the credentials' own, and region-free images", async () => {
    const { provider, credentials } = setup();
    const catalog = await provider.catalog(credentials);
    expect(catalog.provisioning?.location?.choices.map((choice) => choice.id)).toEqual([
      "eu-west-1",
      "us-east-2",
    ]);
    expect(catalog.provisioning?.location?.defaultId).toBe("us-east-2");
    expect(catalog.provisioning?.image?.defaultId).toBe("ubuntu-24.04");
    expect(catalog.provisioning?.image?.choices.every((choice) => choice.locations === null)).toBe(
      true
    );
    expect(catalog.machineTypes.find((type) => type.id === "t4g.medium")).toMatchObject({
      vcpu: 2,
      memoryGB: 4,
      hourlyDollars: null,
    });
  });

  it("creates a tagged instance in the chosen region with the key in user data and SSH let in", async () => {
    const { provider, credentials, fake } = setup();
    const resource = await provider.create(credentials, CREATE);
    expect(resource).toMatchObject({
      name: "Build box",
      machine: "starting",
      machineType: "t3.large",
    });
    expect(resource.resourceId).toMatch(/^eu-west-1\/i-0abc/);
    const run = fake.calls.find((call) => call.action === "RunInstances")!;
    expect(run.region).toBe("eu-west-1");
    expect(run.params.get("ImageId")).toBe("ami-noble-x86_64-new");
    // Every default subnet gives a public address: EC2 picks the zone.
    expect(run.params.has("SubnetId")).toBe(false);
    expect(run.params.get("ClientToken")).toBe(CREATE.idempotencyKey);
    expect(run.params.get("MetadataOptions.HttpTokens")).toBe("required");
    expect(fake.instances[0]!.tags).toEqual({
      daintree: "1",
      "daintree-binding": "bind-1",
      Name: "Build box",
    });
    expect(fake.instances[0]!.userData).toContain(JSON.stringify(CREATE.publicKey));
    expect(fake.groups).toEqual([
      {
        id: "sg-1",
        name: "daintree-ssh",
        vpcId: "vpc-eu-west-1",
        ssh: true,
        tags: { daintree: "1" },
      },
    ]);
    expect(run.params.get("SecurityGroupId.1")).toBe("sg-1");
  });

  it("picks the chosen release's image for the type's architecture", async () => {
    const launched = async (machineType: string, image: string) => {
      const { provider, credentials, fake } = setup();
      await provider.create(credentials, {
        ...CREATE,
        machineType,
        provisioning: { ...CREATE.provisioning, image },
      });
      return fake.calls.find((call) => call.action === "RunInstances")!.params.get("ImageId");
    };
    expect(await launched("t4g.medium", "ubuntu-24.04")).toBe("ami-noble-arm64-new");
    expect(await launched("t3.large", "ubuntu-22.04")).toBe("ami-jammy-x86_64-new");
    expect(await launched("m7g.large", "ubuntu-22.04")).toBe("ami-jammy-arm64-new");
  });

  it("launches into a default subnet that gives a public address, or says why it can't", async () => {
    const mixed = setup({ publicSubnets: "second" });
    await mixed.provider.create(mixed.credentials, CREATE);
    expect(
      mixed.fake.calls.find((call) => call.action === "RunInstances")!.params.get("SubnetId")
    ).toBe("subnet-eu-west-1b");

    const none = setup({ publicSubnets: "none" });
    const refused = await none.provider.create(none.credentials, CREATE).catch((e: unknown) => e);
    expect(none.provider.describeError(refused)).toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("public IPv4 address"),
    });
    expect(none.fake.instances).toHaveLength(0);
  });

  it("never opens SSH on a security group of that name Daintree didn't make", async () => {
    const { provider, credentials, fake } = setup({ foreignGroup: true });
    const refused = await provider.create(credentials, CREATE).catch((e: unknown) => e);
    expect(provider.describeError(refused).message).toMatch(/didn't create/);
    expect(fake.calls.some((call) => call.action === "AuthorizeSecurityGroupIngress")).toBe(false);
    expect(fake.instances).toHaveLength(0);
  });

  it("finds a lost create by its client token instead of launching again", async () => {
    const { provider, credentials, fake } = setup();
    // Another create in the same region comes first in every listing.
    await provider.create(credentials, {
      ...CREATE,
      idempotencyKey: "other-create",
      labels: { daintree: "1", "daintree-binding": "bind-0" },
    });
    const first = await provider.create(credentials, CREATE);
    const again = await provider.create(credentials, CREATE);
    expect(again.resourceId).toBe(first.resourceId);
    expect(fake.instances).toHaveLength(2);
    expect(fake.calls.filter((call) => call.action === "RunInstances")).toHaveLength(2);
    // And by its binding label, across every region.
    const found = await provider.list(credentials, { label: "daintree-binding=bind-1" });
    expect(found.map((entry) => entry.resourceId)).toEqual([first.resourceId]);
    await expect(provider.list(credentials, { label: "daintree-binding=other" })).resolves.toEqual(
      []
    );
  });

  it("finds the launch a client token already made when its parameters changed since", async () => {
    const { provider, credentials, fake } = setup();
    const first = await provider.create(credentials, CREATE);
    // Canonical publishes a newer image, and EC2 doesn't list the instance to the first lookup:
    // the resend names the new image and EC2 refuses it for the token's first launch.
    fake.generation.value = "newer";
    const original = fake.fetch;
    let lookups = 0;
    const lagging = async (input: URL | string, init?: RequestInit) => {
      const action = new URLSearchParams(String(init?.body ?? "")).get("Action");
      if (action === "DescribeInstances" && ++lookups === 1) {
        return xml("<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>");
      }
      return original(input, init);
    };
    const retry = new AwsProvider({
      client: new AwsClient({ fetch: lagging as typeof fetch, sleep: async () => {} }),
      sleep: async () => {},
    });
    await expect(retry.create(credentials, CREATE)).resolves.toMatchObject({
      resourceId: first.resourceId,
    });
    expect(fake.instances).toHaveLength(1);
  });

  it("leaves out a region these keys may not read, finding the machine in the rest", async () => {
    const { provider, credentials } = setup({ refusedRegions: ["us-east-2"] });
    const created = await provider.create(credentials, CREATE);
    await expect(
      provider.list(credentials, { label: "daintree-binding=bind-1" })
    ).resolves.toMatchObject([{ resourceId: created.resourceId }]);
    // Where a create was sent, a refusal is no answer: it never reads as nothing there.
    await expect(
      provider.list(credentials, { label: "daintree-binding=bind-1", location: "eu-west-1" })
    ).resolves.toMatchObject([{ resourceId: created.resourceId }]);
    await expect(
      provider.list(credentials, { label: "daintree-binding=bind-1", location: "us-east-2" })
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("never launches into a group that doesn't let SSH in yet", async () => {
    const { credentials, fake } = setup();
    const original = fake.fetch;
    const unseen = new AwsProvider({
      client: new AwsClient({
        fetch: (async (input: URL | string, init?: RequestInit) => {
          const action = new URLSearchParams(String(init?.body ?? "")).get("Action");
          if (action === "AuthorizeSecurityGroupIngress") {
            return ec2Error("InvalidGroup.NotFound", "The security group does not exist");
          }
          return original(input, init);
        }) as typeof fetch,
        sleep: async () => {},
      }),
      sleep: async () => {},
    });
    await expect(unseen.create(credentials, CREATE)).rejects.toMatchObject({
      code: "InvalidGroup.NotFound",
    });
    expect(fake.instances).toHaveLength(0);
  });

  it("lists only the machines Daintree created", async () => {
    const { provider, credentials, fake } = setup();
    const created = await provider.create(credentials, CREATE);
    fake.instances.push({
      ...fake.instances[0]!,
      id: "i-0fff0000000000001",
      tags: { Name: "theirs" },
      clientToken: "x",
    });
    expect((await provider.list(credentials)).map((entry) => entry.resourceId)).toEqual([
      created.resourceId,
    ]);
  });

  it("asks again about an instance EC2 doesn't list yet", async () => {
    const { provider, credentials, fake } = setup();
    const { resourceId } = await provider.create(credentials, CREATE);
    const launched = fake.instances.splice(0, 1)[0]!;
    let reads = 0;
    const original = fake.fetch;
    const eventual = new AwsProvider({
      client: new AwsClient({
        fetch: (async (input: URL | string, init?: RequestInit) => {
          if (++reads === 2) fake.instances.push(launched);
          return original(input, init);
        }) as typeof fetch,
        sleep: async () => {},
      }),
      sleep: async () => {},
    });
    await expect(eventual.inspect(credentials, resourceId)).resolves.toMatchObject({ resourceId });
  });

  it("says why it can't create in a region without a default VPC, as nothing having been made", async () => {
    const { provider, credentials } = setup({ defaultVpc: false });
    const refused = await provider.create(credentials, CREATE).catch((error: unknown) => error);
    expect(provider.describeError(refused)).toMatchObject({
      code: "unsupported",
      message: expect.stringMatching(/no default VPC/),
    });
  });

  it("asks again about a terminate EC2 refuses for an instance it doesn't list yet", async () => {
    const { provider, credentials, fake } = setup();
    const { resourceId } = await provider.create(credentials, CREATE);
    const launched = fake.instances.splice(0, 1)[0]!;
    let terminates = 0;
    const original = fake.fetch;
    const eventual = new AwsProvider({
      client: new AwsClient({
        fetch: (async (input: URL | string, init?: RequestInit) => {
          const action = new URLSearchParams(String(init?.body ?? "")).get("Action");
          if (action === "TerminateInstances" && ++terminates === 2) fake.instances.push(launched);
          return original(input, init);
        }) as typeof fetch,
        sleep: async () => {},
      }),
      sleep: async () => {},
    });
    await eventual.delete(credentials, resourceId);
    expect(launched.state).toBe("shutting-down");
  });

  it("joins a start whose repeat EC2 refuses because the instance is already starting", async () => {
    const { provider, credentials, fake } = setup();
    const { resourceId } = await provider.create(credentials, CREATE);
    fake.instances[0]!.state = "pending";
    await expect(provider.start(credentials, resourceId, {})).resolves.toMatchObject({
      machine: "starting",
    });
    fake.instances[0]!.state = "stopping";
    await expect(provider.start(credentials, resourceId, {})).rejects.toMatchObject({
      code: "IncorrectInstanceState",
    });
  });

  it("joins a start whose answer was lost and whose resend EC2 refuses", async () => {
    const { provider, credentials, fake } = setup();
    const { resourceId } = await provider.create(credentials, CREATE);
    fake.instances[0]!.state = "stopped";
    const original = fake.fetch;
    let starts = 0;
    const lossy = new AwsProvider({
      client: new AwsClient({
        fetch: (async (input: URL | string, init?: RequestInit) => {
          const action = new URLSearchParams(String(init?.body ?? "")).get("Action");
          // The first start lands, and its answer never arrives.
          if (action === "StartInstances" && ++starts === 1) {
            await original(input, init);
            throw new TypeError("socket hang up");
          }
          return original(input, init);
        }) as typeof fetch,
        sleep: async () => {},
      }),
      sleep: async () => {},
    });
    await expect(lossy.start(credentials, resourceId, {})).resolves.toMatchObject({
      machine: "starting",
    });
    expect(starts).toBe(2);
  });

  it("waits out a read that still shows the machine as it was before joining its start", async () => {
    const { provider, credentials, fake } = setup();
    const { resourceId } = await provider.create(credentials, CREATE);
    fake.instances[0]!.state = "stopped";
    const original = fake.fetch;
    let starts = 0;
    let staleReads = 1;
    const lagging = new AwsProvider({
      client: new AwsClient({
        fetch: (async (input: URL | string, init?: RequestInit) => {
          const action = new URLSearchParams(String(init?.body ?? "")).get("Action");
          if (action === "StartInstances" && ++starts === 1) {
            await original(input, init);
            throw new TypeError("socket hang up");
          }
          // The first read after the start still says stopped.
          if (action === "DescribeInstances" && staleReads > 0) {
            staleReads -= 1;
            const state = fake.instances[0]!.state;
            fake.instances[0]!.state = "stopped";
            try {
              return await original(input, init);
            } finally {
              fake.instances[0]!.state = state;
            }
          }
          return original(input, init);
        }) as typeof fetch,
        sleep: async () => {},
      }),
      sleep: async () => {},
    });
    await expect(lagging.start(credentials, resourceId, {})).resolves.toMatchObject({
      machine: "starting",
    });
  });

  it("asks its client for an idle stop sent once (#17924)", async () => {
    const { provider, credentials, client, fake } = setup();
    const { resourceId } = await provider.create(credentials, CREATE);
    fake.instances[0]!.state = "running";
    const stop = vi.spyOn(client, "stopInstance");
    await provider.stop(credentials, resourceId, { once: true });
    expect(stop).toHaveBeenCalledWith(expect.anything(), fake.instances[0]!.id, {
      once: true,
    });
  });

  it("starts, stops, renames and terminates the instance in its region", async () => {
    const { provider, credentials, fake } = setup();
    const { resourceId } = await provider.create(credentials, CREATE);
    fake.instances[0]!.state = "running";
    await expect(provider.stop(credentials, resourceId)).resolves.toMatchObject({
      machine: "stopping",
    });
    fake.instances[0]!.state = "stopped";
    await expect(provider.inspect(credentials, resourceId)).resolves.toMatchObject({
      machine: "stopped",
      stoppedAt: "2026-11-18T01:02:03.000Z",
    });
    await expect(provider.start(credentials, resourceId, {})).resolves.toMatchObject({
      machine: "starting",
    });
    await provider.rename(credentials, resourceId, "Renamed");
    expect(fake.instances[0]!.tags.Name).toBe("Renamed");
    await provider.delete(credentials, resourceId);
    await expect(provider.inspect(credentials, resourceId)).resolves.toMatchObject({
      machine: "deleted",
    });
    expect(
      new Set(
        fake.calls
          .filter((call) => /Instances$|CreateTags/.test(call.action))
          .map((call) => call.region)
      )
    ).toEqual(new Set(["eu-west-1"]));
    expect(fake.calls.find((call) => call.action === "StopInstances")!.params.has("Force")).toBe(
      false
    );
  });

  it("says a machine it doesn't know isn't found", async () => {
    const { provider, credentials } = setup();
    const refused = await provider
      .inspect(credentials, "us-east-2/i-0abc0000000000999")
      .catch((e: unknown) => e);
    expect(provider.describeError(refused)).toMatchObject({ code: "not-found" });
  });

  it("vouches for the key cloud-init printed to the console", async () => {
    const { provider, credentials, fake } = setup({
      console: () =>
        `-----BEGIN SSH HOST KEY KEYS-----\n${ECDSA} root@x\n${ED25519} root@x\n-----END SSH HOST KEY KEYS-----\n`,
    });
    const { resourceId } = await provider.create(credentials, CREATE);
    fake.instances[0]!.state = "running";
    await expect(provider.sshAccess(credentials, resourceId)).resolves.toEqual({
      user: "ubuntu",
      endpoint: { host: "203.0.113.20", port: 22 },
      hostKey: ED25519,
    });
  });

  it("falls back to the posted console on an instance without the latest output", async () => {
    const { provider, credentials, fake } = setup({
      nitro: false,
      console: () =>
        `-----BEGIN SSH HOST KEY KEYS-----\n${ED25519} root@x\n-----END SSH HOST KEY KEYS-----\n`,
    });
    const { resourceId } = await provider.create(credentials, CREATE);
    fake.instances[0]!.state = "running";
    await expect(provider.sshAccess(credentials, resourceId)).resolves.toMatchObject({
      hostKey: ED25519,
    });
    const reads = fake.calls.filter((call) => call.action === "GetConsoleOutput");
    expect(reads.map((call) => call.params.get("Latest"))).toEqual(["true", null]);
  });

  it("waits briefly for a new machine's console, then leaves the key to the person", async () => {
    let reads = 0;
    const { provider, credentials, fake } = setup({
      console: () => {
        reads += 1;
        return reads < 3
          ? "booting"
          : `-----BEGIN SSH HOST KEY KEYS-----\n${ED25519} root@x\n-----END SSH HOST KEY KEYS-----\n`;
      },
    });
    const { resourceId } = await provider.create(credentials, CREATE);
    fake.instances[0]!.state = "running";
    await expect(provider.sshAccess(credentials, resourceId)).resolves.toMatchObject({
      hostKey: ED25519,
    });
    expect(reads).toBe(3);

    const quiet = setup({ console: () => null });
    const created = await quiet.provider.create(quiet.credentials, CREATE);
    quiet.fake.instances[0]!.state = "running";
    await expect(
      quiet.provider.sshAccess(quiet.credentials, created.resourceId)
    ).resolves.toMatchObject({
      hostKey: null,
    });
    // An old machine's console isn't waited on.
    quiet.fake.instances[0]!.createdAt = "2020-01-01T00:00:00.000Z";
    const before = quiet.fake.calls.length;
    await expect(
      quiet.provider.sshAccess(quiet.credentials, created.resourceId)
    ).resolves.toMatchObject({
      hostKey: null,
    });
    expect(
      quiet.fake.calls.slice(before).filter((call) => call.action === "GetConsoleOutput")
    ).toHaveLength(1);
  });

  it("gives up on a console that never answers at the deadline, but not on a cancelled caller", async () => {
    const fake = fakeAws({ console: () => null });
    let enteredConsole: (() => void) | null = null;
    let consoleSignal: AbortSignal | null = null;
    const stalling = (async (input: URL | string, init?: RequestInit) => {
      const action = new URLSearchParams(String(init?.body ?? "")).get("Action");
      if (action !== "GetConsoleOutput") return fake.fetch(input, init);
      consoleSignal = init?.signal ?? null;
      enteredConsole?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      });
    }) as typeof fetch;
    const provider = new AwsProvider({
      client: new AwsClient({ fetch: stalling, sleep: async () => {} }),
      consoleDeadlineMs: 50,
    });
    const credentials: ProviderCredentials = { values: VALUES, scopeId: ACCOUNT, apiUrl: API };
    const { resourceId } = await provider.create(credentials, CREATE);
    fake.instances[0]!.state = "running";
    await expect(provider.sshAccess(credentials, resourceId)).resolves.toMatchObject({
      hostKey: null,
    });

    // Cancelled while the console read is under way: the caller's cancel, not "no key".
    const caller = new AbortController();
    const reading = new Promise<void>((resolve) => (enteredConsole = resolve));
    const pending = provider.sshAccess({ ...credentials, signal: caller.signal }, resourceId);
    await reading;
    caller.abort();
    // The cancel reaches the request itself, well before the deadline would.
    expect((consoleSignal as AbortSignal | null)?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("leaves the key to the person when the console can't be read", async () => {
    const { provider, credentials, fake } = setup({ denied: new Set(["GetConsoleOutput"]) });
    const { resourceId } = await provider.create(credentials, CREATE);
    fake.instances[0]!.state = "running";
    await expect(provider.sshAccess(credentials, resourceId)).resolves.toMatchObject({
      hostKey: null,
    });
  });

  it("describes AWS's failures in the person's terms", () => {
    const { provider } = setup();
    const of = (kind: AwsApiError["kind"], code: string | null, action: string | null = null) =>
      provider.describeError(new AwsApiError(kind, "said", 400, code, null, action));
    expect(of("unauthorized", "ExpiredToken").message).toMatch(/expired/);
    expect(of("forbidden", "UnauthorizedOperation", "RunInstances")).toMatchObject({
      code: "permission",
      message: expect.stringContaining("ec2:RunInstances"),
    });
    expect(of("capacity", "InsufficientInstanceCapacity").code).toBe("capacity");
    expect(of("billing", "OptInRequired").code).toBe("billing");
    expect(of("rate-limited", "RequestLimitExceeded").code).toBe("rate-limited");
    expect(of("network", null).code).toBe("provider-unreachable");
  });
});

describe("an EC2 machine stopping itself once idle (#17362)", () => {
  async function runningMachine(options: FakeOptions = {}) {
    const harness = setup(options);
    const machine = await harness.provider.create(harness.credentials, CREATE);
    harness.fake.instances[0]!.state = "running";
    return { ...harness, resourceId: machine.resourceId, instance: harness.fake.instances[0]! };
  }

  it("launches instances that stop, rather than terminate, when their own OS powers off", async () => {
    const { fake } = await runningMachine();
    const launch = fake.calls.find((call) => call.action === "RunInstances" && !call.dryRun)!;
    expect(launch.params.get("InstanceInitiatedShutdownBehavior")).toBe("stop");
  });

  it("stops itself after its idle time with no Shell, keeping its disk, with no AWS call from the machine", async () => {
    const { provider, credentials, fake, resourceId, instance } = await runningMachine();
    const check = await provider.checkGuestPowerOff(credentials, resourceId);
    expect(check).toEqual({
      eligible: true,
      target: { provider: "aws", accountId: ACCOUNT, region: "eu-west-1", instanceId: instance.id },
    });
    if (!check.eligible) return;
    const host = cloudMachineHost({
      metadata: fake.metadataFor(instance.id),
      powerOff: () => fake.guestPowerOff(instance.id),
    });
    // All the Shell hands over: which machine it is. No key, no secret.
    await expect(host.keeper.set({ target: check.target, enabled: true })).resolves.toEqual({
      armed: true,
      problem: null,
    });
    // The Shell goes away; from here only the machine acts.
    const callsBefore = fake.calls.length;
    await host.pass(0);
    await host.pass((IDLE_MINUTES - 1) * MINUTE);
    expect(host.powerOffs).toEqual([]);
    expect(instance.state).toBe("running");
    await host.pass(2 * MINUTE);
    expect(host.powerOffs).toEqual([["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "poweroff"]]);
    await host.pass(MINUTE);
    expect(host.powerOffs).toHaveLength(1);
    expect(fake.calls.slice(callsBefore)).toEqual([]);

    await expect(provider.inspect(credentials, resourceId)).resolves.toMatchObject({
      resourceId,
      machine: "stopped",
      error: null,
    });
    expect(fake.instances).toHaveLength(1);
    expect(fake.calls.filter((call) => call.action === "StopInstances")).toEqual([]);
    expect(fake.calls.filter((call) => call.action === "TerminateInstances")).toEqual([]);
    host.dispose();
  });

  it("still stops itself after its host restarts in the same boot with no Shell", async () => {
    const { provider, credentials, fake, resourceId, instance } = await runningMachine();
    const check = await provider.checkGuestPowerOff(credentials, resourceId);
    if (!check.eligible) throw new Error("not eligible");
    const host = cloudMachineHost({
      metadata: fake.metadataFor(instance.id),
      powerOff: () => fake.guestPowerOff(instance.id),
    });
    await host.keeper.set({ target: check.target, enabled: true });
    await host.restart();
    expect(host.keeper.status()).toEqual({ armed: true, problem: null });
    await host.pass(0);
    await host.pass((IDLE_MINUTES + 1) * MINUTE);
    expect(host.powerOffs).toHaveLength(1);
    expect(instance.state).toBe("stopped");
    host.dispose();
  });

  it("holds while the host sees work, and counts a full idle time from when the work ends", async () => {
    const { provider, credentials, fake, resourceId, instance } = await runningMachine();
    const check = await provider.checkGuestPowerOff(credentials, resourceId);
    if (!check.eligible) throw new Error("not eligible");
    const host = cloudMachineHost({
      metadata: fake.metadataFor(instance.id),
      powerOff: () => fake.guestPowerOff(instance.id),
    });
    await host.keeper.set({ target: check.target, enabled: true });
    host.setBusy(true);
    for (let elapsed = 0; elapsed < 4 * IDLE_MINUTES; elapsed += 10) {
      await host.pass(10 * MINUTE);
    }
    expect(host.powerOffs).toEqual([]);
    expect(instance.state).toBe("running");
    host.setBusy(false);
    await host.pass(MINUTE);
    await host.pass((IDLE_MINUTES - 2) * MINUTE);
    expect(host.powerOffs).toEqual([]);
    await host.pass(2 * MINUTE);
    expect(host.powerOffs).toHaveLength(1);
    expect(instance.state).toBe("stopped");
    host.dispose();
  });

  it("never lets a machine whose own shutdown would delete or end it power itself off", async () => {
    const { provider, credentials, resourceId, instance } = await runningMachine();
    const target = {
      provider: "aws",
      accountId: ACCOUNT,
      region: "eu-west-1",
      instanceId: instance.id,
    };

    instance.shutdownBehavior = "terminate";
    await expect(provider.checkGuestPowerOff(credentials, resourceId)).resolves.toEqual({
      eligible: false,
      target,
      problem: expect.stringContaining("terminate"),
    });
    instance.shutdownBehavior = "stop";
    instance.rootDeviceType = "instance-store";
    await expect(provider.checkGuestPowerOff(credentials, resourceId)).resolves.toEqual({
      eligible: false,
      target,
      problem: expect.stringContaining("EBS"),
    });
    instance.rootDeviceType = "ebs";
    instance.lifecycle = "spot";
    await expect(provider.checkGuestPowerOff(credentials, resourceId)).resolves.toEqual({
      eligible: false,
      target,
      problem: expect.stringContaining("spot"),
    });
    instance.lifecycle = undefined;
    instance.tags["aws:autoscaling:groupName"] = "builders";
    await expect(provider.checkGuestPowerOff(credentials, resourceId)).resolves.toEqual({
      eligible: false,
      target,
      problem: expect.stringContaining("Auto Scaling"),
    });
    delete instance.tags["aws:autoscaling:groupName"];
    // A type with local instance-store disks, whose data no stop keeps.
    instance.type = "m5d.large";
    await expect(provider.checkGuestPowerOff(credentials, resourceId)).resolves.toEqual({
      eligible: false,
      target,
      problem: expect.stringContaining("local disks"),
    });
    instance.type = "t3.large";
    await expect(provider.checkGuestPowerOff(credentials, resourceId)).resolves.toEqual({
      eligible: true,
      target,
    });
  });

  it("says which permission it lacks when the keys can't read the shutdown setting", async () => {
    const { provider, credentials, resourceId } = await runningMachine({
      denied: new Set(["DescribeInstanceAttribute"]),
    });
    await expect(provider.checkGuestPowerOff(credentials, resourceId)).resolves.toEqual({
      eligible: false,
      target: expect.objectContaining({ provider: "aws", region: "eu-west-1" }),
      problem: expect.stringContaining("ec2:DescribeInstanceAttribute"),
    });
  });

  it("refuses to power off a machine whose metadata names another instance", async () => {
    const { provider, credentials, fake, resourceId, instance } = await runningMachine();
    const other = await provider.create(credentials, {
      ...CREATE,
      idempotencyKey: "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9",
    });
    const check = await provider.checkGuestPowerOff(credentials, other.resourceId);
    if (!check.eligible) throw new Error("not eligible");
    // This host runs on the first instance; the Shell names the second.
    const host = cloudMachineHost({
      metadata: fake.metadataFor(instance.id),
      powerOff: () => fake.guestPowerOff(instance.id),
    });
    await expect(host.keeper.set({ target: check.target, enabled: true })).resolves.toEqual({
      armed: false,
      problem: expect.stringContaining("another machine"),
    });
    await host.pass(0);
    await host.pass(2 * IDLE_MINUTES * MINUTE);
    expect(host.powerOffs).toEqual([]);
    await expect(provider.inspect(credentials, resourceId)).resolves.toMatchObject({
      machine: "running",
    });
    host.dispose();
  });

  it("reports an instance that stopped itself as stopped, not failed, by AWS's reason code", async () => {
    const { provider, credentials, fake, resourceId, instance } = await runningMachine();
    fake.guestPowerOff(instance.id);
    await expect(provider.inspect(credentials, resourceId)).resolves.toMatchObject({
      machine: "stopped",
      error: null,
    });
    // The code alone decides it, whatever the message says.
    instance.stateReason = { code: "Client.InstanceInitiatedShutdown", message: "Shut down" };
    await expect(provider.inspect(credentials, resourceId)).resolves.toMatchObject({
      machine: "stopped",
      error: null,
    });
    instance.stateReason = { code: "Server.InternalError", message: "Server.InternalError: boom" };
    await expect(provider.inspect(credentials, resourceId)).resolves.toMatchObject({
      machine: "stopped",
      error: "Server.InternalError: boom",
    });
    // One that terminated on its own shutdown keeps AWS's word on why it went.
    instance.state = "running";
    instance.shutdownBehavior = "terminate";
    fake.guestPowerOff(instance.id);
    await expect(provider.inspect(credentials, resourceId)).resolves.toMatchObject({
      machine: "deleted",
      error: "Client.InstanceInitiatedShutdown: Instance initiated shutdown",
    });
  });
});
