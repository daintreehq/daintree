import type { CloudMachineState } from "../../../../shared/types/cloudHosts.js";

/** EC2's instance state as a machine state. */
export function ec2MachineState(state: string): CloudMachineState {
  switch (state) {
    case "pending":
      return "starting";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    // Terminating can't be undone: the machine is already on its way out.
    case "shutting-down":
    case "terminated":
      return "deleted";
    default:
      return "unknown";
  }
}

export type Ec2Architecture = "x86_64" | "arm64";

export interface Ec2InstanceTypeSpec {
  id: string;
  vcpu: number;
  memoryGB: number;
  architecture: Ec2Architecture;
}

/**
 * The instance types Add host offers: general-purpose sizes with room for a
 * Host and its agents, Intel and Graviton. The account and region decide
 * whether one can launch; a type a region doesn't offer is refused at create.
 */
export const EC2_INSTANCE_TYPES: readonly Ec2InstanceTypeSpec[] = [
  { id: "t3.medium", vcpu: 2, memoryGB: 4, architecture: "x86_64" },
  { id: "t3.large", vcpu: 2, memoryGB: 8, architecture: "x86_64" },
  { id: "t3.xlarge", vcpu: 4, memoryGB: 16, architecture: "x86_64" },
  { id: "m7i.large", vcpu: 2, memoryGB: 8, architecture: "x86_64" },
  { id: "m7i.xlarge", vcpu: 4, memoryGB: 16, architecture: "x86_64" },
  { id: "m7i.2xlarge", vcpu: 8, memoryGB: 32, architecture: "x86_64" },
  { id: "t4g.medium", vcpu: 2, memoryGB: 4, architecture: "arm64" },
  { id: "t4g.large", vcpu: 2, memoryGB: 8, architecture: "arm64" },
  { id: "t4g.xlarge", vcpu: 4, memoryGB: 16, architecture: "arm64" },
  { id: "m7g.large", vcpu: 2, memoryGB: 8, architecture: "arm64" },
  { id: "m7g.xlarge", vcpu: 4, memoryGB: 16, architecture: "arm64" },
  { id: "m7g.2xlarge", vcpu: 8, memoryGB: 32, architecture: "arm64" },
];

export function ec2InstanceType(id: string | null | undefined): Ec2InstanceTypeSpec | null {
  return EC2_INSTANCE_TYPES.find((type) => type.id === id) ?? null;
}

/** The machine type label: the type and the processor family it runs. */
export function ec2InstanceTypeLabel(spec: Ec2InstanceTypeSpec): string {
  return `${spec.id} (${spec.architecture === "arm64" ? "Graviton, Arm64" : "Intel, x86-64"})`;
}

/** Canonical's AWS account, the publisher of the official Ubuntu images. */
export const CANONICAL_OWNER_ID = "099720109477";

/** The user Ubuntu's images give the SSH key to. */
export const EC2_SSH_USER = "ubuntu";

export interface Ec2ImageSpec {
  id: string;
  label: string;
  description: string;
  /** AMI name patterns per architecture, newest family first; DescribeImages ORs them. */
  namePatterns: Record<Ec2Architecture, string[]>;
}

/**
 * The images Add host offers. An AMI id differs in every region and with
 * every release, so a choice names the release and the newest of Canonical's
 * images for it is looked up in the chosen region, for the instance type's
 * architecture, when the machine is created.
 */
export const EC2_IMAGES: readonly Ec2ImageSpec[] = [
  {
    id: "ubuntu-24.04",
    label: "Ubuntu 24.04 LTS",
    description: "Canonical's latest Ubuntu Server 24.04 image for the instance type",
    namePatterns: {
      x86_64: ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"],
      arm64: ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"],
    },
  },
  {
    id: "ubuntu-22.04",
    label: "Ubuntu 22.04 LTS",
    description: "Canonical's latest Ubuntu Server 22.04 image for the instance type",
    namePatterns: {
      x86_64: [
        "ubuntu/images/hvm-ssd-gp3/ubuntu-jammy-22.04-amd64-server-*",
        "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*",
      ],
      arm64: [
        "ubuntu/images/hvm-ssd-gp3/ubuntu-jammy-22.04-arm64-server-*",
        "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-arm64-server-*",
      ],
    },
  },
];

export const DEFAULT_EC2_IMAGE = "ubuntu-24.04";

export function ec2Image(id: string | null | undefined): Ec2ImageSpec | null {
  return EC2_IMAGES.find((image) => image.id === id) ?? null;
}

/** The root disk a machine is created with, in GiB: room for a Host, its agents and a few checkouts. */
export const EC2_ROOT_VOLUME_GIB = 32;

/** The security group Daintree keeps in each region's default VPC, letting SSH in. */
export const EC2_SECURITY_GROUP_NAME = "daintree-ssh";

/** Region names as AWS's console shows them; an unknown region shows its code. */
const REGION_NAMES: Record<string, string> = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "af-south-1": "Africa (Cape Town)",
  "ap-east-1": "Asia Pacific (Hong Kong)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "ap-south-2": "Asia Pacific (Hyderabad)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-northeast-2": "Asia Pacific (Seoul)",
  "ap-northeast-3": "Asia Pacific (Osaka)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-southeast-3": "Asia Pacific (Jakarta)",
  "ap-southeast-4": "Asia Pacific (Melbourne)",
  "ca-central-1": "Canada (Central)",
  "ca-west-1": "Canada West (Calgary)",
  "eu-central-1": "Europe (Frankfurt)",
  "eu-central-2": "Europe (Zurich)",
  "eu-west-1": "Europe (Ireland)",
  "eu-west-2": "Europe (London)",
  "eu-west-3": "Europe (Paris)",
  "eu-north-1": "Europe (Stockholm)",
  "eu-south-1": "Europe (Milan)",
  "eu-south-2": "Europe (Spain)",
  "il-central-1": "Israel (Tel Aviv)",
  "me-south-1": "Middle East (Bahrain)",
  "me-central-1": "Middle East (UAE)",
  "mx-central-1": "Mexico (Central)",
  "sa-east-1": "South America (São Paulo)",
};

export function ec2RegionLabel(region: string): string {
  const name = REGION_NAMES[region];
  return name ? `${name} · ${region}` : region;
}

/**
 * The host keys cloud-init printed to the instance's console, normalised by
 * `normalize`, strongest first; [] when the block isn't there (yet).
 */
export function consoleHostKeys(
  output: string,
  normalize: (value: string) => string | null
): string[] {
  const begin = output.lastIndexOf("-----BEGIN SSH HOST KEY KEYS-----");
  if (begin === -1) return [];
  const end = output.indexOf("-----END SSH HOST KEY KEYS-----", begin);
  if (end === -1) return [];
  const keys: string[] = [];
  for (const line of output.slice(begin, end).split(/\r?\n/).slice(1)) {
    // A console line may carry a kernel timestamp or cloud-init prefix before the key.
    const match = /((?:ssh|ecdsa|sk)-[A-Za-z0-9@.-]+)\s+([A-Za-z0-9+/]+={0,3})(?:\s|$)/.exec(line);
    const key = match ? normalize(`${match[1]} ${match[2]}`) : null;
    if (key && !keys.includes(key)) keys.push(key);
  }
  const rank = (key: string) => {
    if (key.startsWith("ssh-ed25519 ")) return 0;
    if (key.startsWith("ecdsa-sha2-nistp")) return 1;
    return 2;
  };
  return keys.sort((a, b) => rank(a) - rank(b));
}

/** "User initiated (2026-11-18 01:02:03 GMT)" → ISO time; null when the reason doesn't carry one. */
export function ec2TransitionTime(reason: string | null): string | null {
  const match = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT\)/.exec(reason ?? "");
  if (!match) return null;
  const at = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
