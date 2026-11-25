import type { AkashScreeningRequest } from "./akashSchemas.js";

/**
 * A machine size Daintree offers on Akash. Akash has no sizes of its own: a
 * deployment asks for CPU, memory and storage, so these are Daintree's.
 */
export interface AkashInstanceType {
  id: string;
  vcpu: number;
  /** Memory and disk in GiB, as an SDL spells them ("16Gi"). */
  memoryGiB: number;
  diskGiB: number;
}

export const AKASH_INSTANCE_TYPES: readonly AkashInstanceType[] = [
  { id: "akash-4c-16g", vcpu: 4, memoryGiB: 16, diskGiB: 100 },
  { id: "akash-8c-32g", vcpu: 8, memoryGiB: 32, diskGiB: 200 },
  { id: "akash-16c-64g", vcpu: 16, memoryGiB: 64, diskGiB: 400 },
  { id: "akash-32c-128g", vcpu: 32, memoryGiB: 128, diskGiB: 800 },
];

export function akashInstanceType(id: string): AkashInstanceType | null {
  return AKASH_INSTANCE_TYPES.find((type) => type.id === id) ?? null;
}

const GIB = 1024 ** 3;

export function akashInstanceTypeLabel(type: AkashInstanceType): string {
  return `${type.vcpu} vCPU, ${type.memoryGiB} GB memory, ${type.diskGiB} GB disk`;
}

/**
 * The Console's own auditor, whose signature marks a provider audited: the
 * placement options count only providers it signed, and Console's own
 * screening asks for it.
 */
export const AKASH_CONSOLE_AUDITOR = "akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63";

/**
 * A screening request for one machine of `type`: audited providers only, in
 * any region. The chain spells CPU in millicores and sizes in bytes.
 */
export function akashScreeningRequest(type: AkashInstanceType): AkashScreeningRequest {
  return {
    requirements: { signedBy: { allOf: [], anyOf: [AKASH_CONSOLE_AUDITOR] }, attributes: [] },
    resources: [
      {
        resource: {
          id: 1,
          cpu: { units: { val: String(type.vcpu * 1000) } },
          memory: { quantity: { val: String(type.memoryGiB * GIB) } },
          gpu: { units: { val: "0" } },
          storage: [{ name: "default", quantity: { val: String(type.diskGiB * GIB) } }],
          endpoints: [],
        },
        count: 1,
        // Screening matches capacity, not price; the field is required, so it names a nominal one.
        price: { denom: "uact", amount: "1000000" },
      },
    ],
    // Only the incident history is per day; UTC asks nothing about where the person is.
    timezone: "UTC",
  };
}
