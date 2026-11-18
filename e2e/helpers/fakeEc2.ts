import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the slice of the EC2 and STS Query APIs Daintree's AWS
 * provider calls, answering in their XML envelopes, at `{url}/{service}/{region}/`
 * (what `DAINTREE_AWS_API_URL` points a development build at). Its instances
 * are one private sshd on this Mac: a launch's user data authorizes its SSH
 * key there, and its console output reports that sshd's host key once a
 * moment has passed, as cloud-init's does after boot.
 *
 * It checks that every request is signed for the fake key id, refuses DryRun
 * calls for the actions in `denied`, and records every call it answers.
 */

export const FAKE_AWS_ACCOUNT = "123456789012";
export const FAKE_AWS_ACCESS_KEY_ID = "AKIAE2EEXAMPLE000001";
export const FAKE_AWS_SECRET = "e2eSecretAccessKey/0123456789abcdefghijklmn";
export const FAKE_AWS_REGIONS = ["eu-west-1", "us-east-2"];

export interface FakeEc2Request {
  service: string;
  region: string;
  action: string;
  params: Record<string, string>;
  dryRun: boolean;
  at: number;
}

export interface FakeEc2Instance {
  id: string;
  region: string;
  state: string;
  type: string;
  imageId: string;
  clientToken: string;
  tags: Record<string, string>;
  userData: string;
  launchedAt: number;
}

export interface FakeEc2 {
  url: string;
  requests: FakeEc2Request[];
  instances: Map<string, FakeEc2Instance>;
  /** Actions a DryRun is refused for, as an IAM policy without them would. */
  denied: Set<string>;
  /** How long pending, stopping and shutting-down take. */
  transitionMs: number;
  /** How long after launch the console reports the host key. */
  consoleDelayMs: number;
  /** Calls answered for one action, DryRun probes left out. */
  calls(action: string): FakeEc2Request[];
  stop(): Promise<void>;
}

function xmlEscape(value: string): string {
  return value.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export async function startFakeEc2(params: { sshdRoot: string }): Promise<FakeEc2> {
  const hostKey = (await fs.readFile(path.join(params.sshdRoot, "hostkey.pub"), "utf8")).trim();
  const authorizedKeys = path.join(params.sshdRoot, "authorized_keys");
  const requests: FakeEc2Request[] = [];
  const instances = new Map<string, FakeEc2Instance>();
  const groups: Array<{
    id: string;
    name: string;
    vpcId: string;
    ssh: boolean;
    tags: Record<string, string>;
  }> = [];
  const timers = new Set<NodeJS.Timeout>();
  let counter = 0;

  const fake: FakeEc2 = {
    url: "",
    requests,
    instances,
    denied: new Set(),
    transitionMs: 1_500,
    consoleDelayMs: 3_000,
    calls: (action) => requests.filter((r) => r.action === action && !r.dryRun),
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const later = (fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, fake.transitionMs);
    timers.add(timer);
  };

  const instanceXml = (instance: FakeEc2Instance) => {
    const launched = new Date(instance.launchedAt).toISOString();
    const running = instance.state === "running";
    return `<item>
  <instanceId>${instance.id}</instanceId>
  <imageId>${instance.imageId}</imageId>
  <instanceState><code>0</code><name>${instance.state}</name></instanceState>
  <reason>${instance.state === "stopped" ? "User initiated (2026-11-18 01:02:03 GMT)" : ""}</reason>
  <instanceType>${xmlEscape(instance.type)}</instanceType>
  <launchTime>${launched}</launchTime>
  ${running ? "<ipAddress>203.0.113.20</ipAddress><dnsName>ec2-203-0-113-20.compute.amazonaws.com</dnsName>" : ""}
  <architecture>x86_64</architecture>
  <rootDeviceName>/dev/sda1</rootDeviceName>
  <blockDeviceMapping><item><deviceName>/dev/sda1</deviceName><ebs><volumeId>vol-0e2e</volumeId><status>attached</status><attachTime>${launched}</attachTime><deleteOnTermination>true</deleteOnTermination></ebs></item></blockDeviceMapping>
  <tagSet>${Object.entries(instance.tags)
    .map(
      ([key, value]) =>
        `<item><key>${xmlEscape(key)}</key><value>${xmlEscape(value)}</value></item>`
    )
    .join("")}</tagSet>
</item>`;
  };

  const filtersOf = (p: Record<string, string>) => {
    const out: Array<{ name: string; values: string[] }> = [];
    for (let i = 1; p[`Filter.${i}.Name`] !== undefined; i++) {
      const values: string[] = [];
      for (let j = 1; p[`Filter.${i}.Value.${j}`] !== undefined; j++)
        values.push(p[`Filter.${i}.Value.${j}`]!);
      out.push({ name: p[`Filter.${i}.Name`]!, values });
    }
    return out;
  };

  const tagsOf = (p: Record<string, string>, prefix: string) => {
    const tags: Record<string, string> = {};
    for (let i = 1; p[`${prefix}.${i}.Key`] !== undefined; i++) {
      tags[p[`${prefix}.${i}.Key`]!] = p[`${prefix}.${i}.Value`] ?? "";
    }
    return tags;
  };

  /** Cloud-init's `ssh_authorized_keys`, as the launch's user data lists them. */
  const authorizeFromUserData = async (userData: string) => {
    const keys = [...userData.matchAll(/^\s*-\s*"(.+)"\s*$/gm)].map(
      (m) => JSON.parse(`"${m[1]}"`) as string
    );
    const current = await fs.readFile(authorizedKeys, "utf8").catch(() => "");
    for (const key of keys) {
      if (!current.includes(key)) await fs.appendFile(authorizedKeys, `${key}\n`);
    }
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://fake");
        const [, service = "", region = ""] = url.pathname.replace(/^\/aws(?=\/)/, "").split("/");
        const p = Object.fromEntries(new URLSearchParams(raw));
        const action = p.Action ?? "";
        const dryRun = p.DryRun === "true";
        requests.push({ service, region, action, params: p, dryRun, at: Date.now() });
        const send = (status: number, body: string) => {
          res.writeHead(status, { "content-type": "text/xml;charset=UTF-8" });
          res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
        };
        const fail = (status: number, code: string, message: string) =>
          service === "sts"
            ? send(
                status,
                `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error><RequestId>req-fake</RequestId></ErrorResponse>`
              )
            : send(
                status,
                `<Response><Errors><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error></Errors><RequestID>req-fake</RequestID></Response>`
              );
        const auth = String(req.headers.authorization ?? "");
        if (!auth.includes(`Credential=${FAKE_AWS_ACCESS_KEY_ID}/`)) {
          fail(401, "AuthFailure", "AWS was not able to validate the provided access credentials");
          return;
        }
        if (service === "sts" && action === "GetCallerIdentity") {
          send(
            200,
            `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::${FAKE_AWS_ACCOUNT}:user/e2e</Arn><UserId>AIDAE2E</UserId><Account>${FAKE_AWS_ACCOUNT}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`
          );
          return;
        }
        if (service !== "ec2" || !FAKE_AWS_REGIONS.includes(region)) {
          fail(400, "InvalidAction", `No ${service} in ${region}`);
          return;
        }
        if (dryRun) {
          if (fake.denied.has(action)) {
            fail(403, "UnauthorizedOperation", "You are not authorized to perform this operation.");
          } else {
            fail(412, "DryRunOperation", "Request would have succeeded, but DryRun flag is set.");
          }
          return;
        }
        const here = [...instances.values()].filter((instance) => instance.region === region);
        const byId = (id: string | undefined) => here.find((instance) => instance.id === id);
        switch (action) {
          case "DescribeRegions":
            send(
              200,
              `<DescribeRegionsResponse><regionInfo>${FAKE_AWS_REGIONS.map((name) => `<item><regionName>${name}</regionName><regionEndpoint>ec2.${name}.amazonaws.com</regionEndpoint><optInStatus>opt-in-not-required</optInStatus></item>`).join("")}</regionInfo></DescribeRegionsResponse>`
            );
            return;
          case "DescribeInstances": {
            let found = here;
            if (p["InstanceId.1"] !== undefined) {
              found = here.filter((instance) => instance.id === p["InstanceId.1"]);
              if (found.length === 0) {
                fail(
                  400,
                  "InvalidInstanceID.NotFound",
                  `The instance ID '${p["InstanceId.1"]}' does not exist`
                );
                return;
              }
            }
            for (const filter of filtersOf(p)) {
              found = found.filter((instance) => {
                if (filter.name === "instance-state-name")
                  return filter.values.includes(instance.state);
                if (filter.name === "client-token")
                  return filter.values.includes(instance.clientToken);
                if (filter.name === "tag-key")
                  return filter.values.some((key) => key in instance.tags);
                if (filter.name.startsWith("tag:")) {
                  return filter.values.includes(instance.tags[filter.name.slice(4)] ?? "");
                }
                return true;
              });
            }
            send(
              200,
              `<DescribeInstancesResponse><reservationSet>${found.map((instance) => `<item><reservationId>r-0e2e</reservationId><instancesSet>${instanceXml(instance)}</instancesSet></item>`).join("")}</reservationSet></DescribeInstancesResponse>`
            );
            return;
          }
          case "DescribeImages":
            send(
              200,
              `<DescribeImagesResponse><imagesSet><item><imageId>ami-0e2e${region.replace(/\W/g, "")}</imageId><name>ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261101</name><architecture>x86_64</architecture><creationDate>2026-11-01T00:00:00.000Z</creationDate><rootDeviceName>/dev/sda1</rootDeviceName></item></imagesSet></DescribeImagesResponse>`
            );
            return;
          case "DescribeVpcs":
            send(
              200,
              `<DescribeVpcsResponse><vpcSet><item><vpcId>vpc-${region}</vpcId><isDefault>true</isDefault></item></vpcSet></DescribeVpcsResponse>`
            );
            return;
          case "DescribeSecurityGroups": {
            const filters = filtersOf(p);
            const names = filters.find((f) => f.name === "group-name")?.values ?? [];
            const vpc = filters.find((f) => f.name === "vpc-id")?.values[0];
            const all = [
              ...groups,
              {
                id: `sg-default-${region}`,
                name: "default",
                vpcId: `vpc-${region}`,
                ssh: false,
                tags: {} as Record<string, string>,
              },
            ];
            const found = all.filter(
              (group) =>
                (names.length === 0 || names.includes(group.name)) && (!vpc || group.vpcId === vpc)
            );
            send(
              200,
              `<DescribeSecurityGroupsResponse><securityGroupInfo>${found
                .map(
                  (group) =>
                    `<item><groupId>${group.id}</groupId><groupName>${group.name}</groupName><vpcId>${group.vpcId}</vpcId><ipPermissions>${group.ssh ? "<item><ipProtocol>tcp</ipProtocol><fromPort>22</fromPort><toPort>22</toPort><ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges></item>" : ""}</ipPermissions><tagSet>${Object.entries(
                      group.tags
                    )
                      .map(
                        ([key, value]) =>
                          `<item><key>${xmlEscape(key)}</key><value>${xmlEscape(value)}</value></item>`
                      )
                      .join("")}</tagSet></item>`
                )
                .join("")}</securityGroupInfo></DescribeSecurityGroupsResponse>`
            );
            return;
          }
          case "DescribeSubnets":
            send(
              200,
              `<DescribeSubnetsResponse><subnetSet>${["a", "b"]
                .map(
                  (zone) =>
                    `<item><subnetId>subnet-${region}${zone}</subnetId><availabilityZone>${region}${zone}</availabilityZone><defaultForAz>true</defaultForAz><mapPublicIpOnLaunch>true</mapPublicIpOnLaunch></item>`
                )
                .join("")}</subnetSet></DescribeSubnetsResponse>`
            );
            return;
          case "CreateSecurityGroup": {
            const id = `sg-0e2e${++counter}`;
            groups.push({
              id,
              name: p.GroupName ?? "",
              vpcId: p.VpcId ?? "",
              ssh: false,
              tags: tagsOf(p, "TagSpecification.1.Tag"),
            });
            send(
              200,
              `<CreateSecurityGroupResponse><return>true</return><groupId>${id}</groupId></CreateSecurityGroupResponse>`
            );
            return;
          }
          case "AuthorizeSecurityGroupIngress": {
            const group = groups.find((entry) => entry.id === p.GroupId);
            if (group?.ssh) {
              fail(400, "InvalidPermission.Duplicate", "the specified rule already exists");
              return;
            }
            if (group) group.ssh = true;
            send(
              200,
              `<AuthorizeSecurityGroupIngressResponse><return>true</return></AuthorizeSecurityGroupIngressResponse>`
            );
            return;
          }
          case "RunInstances": {
            const token = p.ClientToken ?? "";
            let instance = here.find((entry) => entry.clientToken === token);
            if (!instance) {
              const userData = Buffer.from(p.UserData ?? "", "base64").toString("utf8");
              instance = {
                id: `i-0e2e${String(++counter).padStart(13, "0")}`,
                region,
                state: "pending",
                type: p.InstanceType ?? "",
                imageId: p.ImageId ?? "",
                clientToken: token,
                tags: tagsOf(p, "TagSpecification.1.Tag"),
                userData,
                launchedAt: Date.now(),
              };
              instances.set(instance.id, instance);
              await authorizeFromUserData(userData);
              const launched = instance;
              later(() => {
                if (launched.state === "pending") launched.state = "running";
              });
            }
            send(
              200,
              `<RunInstancesResponse><reservationId>r-0e2e</reservationId><ownerId>${FAKE_AWS_ACCOUNT}</ownerId><instancesSet>${instanceXml(instance)}</instancesSet></RunInstancesResponse>`
            );
            return;
          }
          case "StartInstances":
          case "StopInstances":
          case "TerminateInstances": {
            const instance = byId(p["InstanceId.1"]);
            if (!instance) {
              fail(
                400,
                "InvalidInstanceID.NotFound",
                `The instance ID '${p["InstanceId.1"]}' does not exist`
              );
              return;
            }
            const [moving, settled] =
              action === "StartInstances"
                ? ["pending", "running"]
                : action === "StopInstances"
                  ? ["stopping", "stopped"]
                  : ["shutting-down", "terminated"];
            if (action === "StartInstances" && instance.state !== "stopped") {
              fail(
                400,
                "IncorrectInstanceState",
                `The instance '${instance.id}' is not in a state from which it can be started.`
              );
              return;
            }
            const previous = instance.state;
            if (instance.state !== settled) instance.state = moving!;
            later(() => {
              if (instance.state === moving) instance.state = settled!;
            });
            const tag = `${action}Response`;
            send(
              200,
              `<${tag}><instancesSet><item><instanceId>${instance.id}</instanceId><currentState><code>0</code><name>${instance.state}</name></currentState><previousState><code>0</code><name>${previous}</name></previousState></item></instancesSet></${tag}>`
            );
            return;
          }
          case "CreateTags": {
            const instance = byId(p["ResourceId.1"]);
            if (instance) Object.assign(instance.tags, tagsOf(p, "Tag"));
            send(200, `<CreateTagsResponse><return>true</return></CreateTagsResponse>`);
            return;
          }
          case "GetConsoleOutput": {
            const instance = byId(p.InstanceId);
            if (!instance) {
              fail(400, "InvalidInstanceID.NotFound", "does not exist");
              return;
            }
            const ready = Date.now() - instance.launchedAt >= fake.consoleDelayMs;
            const output = ready
              ? `[   9.1] cloud-init[812]: Cloud-init v. 24.4 running 'modules:final'\n-----BEGIN SSH HOST KEY KEYS-----\n${hostKey}\n-----END SSH HOST KEY KEYS-----\n`
              : "";
            send(
              200,
              `<GetConsoleOutputResponse><instanceId>${instance.id}</instanceId><timestamp>${new Date().toISOString()}</timestamp>${output ? `<output>${Buffer.from(output).toString("base64")}</output>` : ""}</GetConsoleOutputResponse>`
            );
            return;
          }
          default:
            fail(400, "InvalidAction", `The action ${action} is not valid for this web service.`);
        }
      })().catch((error: unknown) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(error));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/aws`;
  return fake;
}
