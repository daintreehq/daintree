/**
 * What a lease's price per block costs in dollars, the way the Akash Console
 * itself reports it. Console's API counts a block as 6 seconds and a month as
 * 30.437 days, and rounds each lease's monthly cost to a whole micro-unit
 * (akash-network/console 201f4e89d3d5b97ccf98403008c49e778f4c2161:
 * apps/api/src/utils/constants.ts L4-L8,
 * apps/api/src/deployment/services/deployment-reader/deployment-reader.service.ts L661).
 * Its managed wallet pays in uact: ACT has 6 decimals and Console prices it at
 * one dollar (apps/deploy-web/src/utils/denomLabel.ts L6-L11,
 * apps/deploy-web/src/hooks/usePricing/usePricing.ts L37).
 */

/** The only denomination Daintree prices: Console's dollar credit, in millionths. */
export const AKASH_UACT = "uact";

const BLOCK_SECONDS = 6;
const DAYS_IN_MONTH = 30.437;
const UACT_PER_DOLLAR = 1_000_000;
const BLOCKS_PER_HOUR = 3600 / BLOCK_SECONDS;
const BLOCKS_PER_MONTH = (DAYS_IN_MONTH * 24 * 3600) / BLOCK_SECONDS;

/** A per-block amount as the chain writes it, or null when it isn't a finite, non-negative number. */
function perBlock(amount: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(amount)) return null;
  const value = Number(amount);
  return Number.isFinite(value) ? value : null;
}

/** Dollars per running hour for a price in uact per block; null when the amount can't be read. */
export function akashHourlyDollars(uactPerBlock: string): number | null {
  const value = perBlock(uactPerBlock);
  return value === null ? null : finite((value * BLOCKS_PER_HOUR) / UACT_PER_DOLLAR);
}

/** Dollars per month for a price in uact per block, as Console shows it; null when the amount can't be read. */
export function akashMonthlyDollars(uactPerBlock: string): number | null {
  const value = perBlock(uactPerBlock);
  return value === null ? null : finite(Math.round(value * BLOCKS_PER_MONTH) / UACT_PER_DOLLAR);
}

function finite(dollars: number): number | null {
  return Number.isFinite(dollars) ? dollars : null;
}
