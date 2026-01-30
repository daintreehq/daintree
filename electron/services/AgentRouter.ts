/**
 * AgentRouter - Capability-based router service for intelligent agent dispatch.
 *
 * Implements filter-score-select pattern:
 * 1. Filter: Only agents with required capabilities and availability
 * 2. Score: Rank by domain weight + load + availability
 * 3. Select: Top-scored or weighted lottery selection
 */

import { getEffectiveRegistry, getEffectiveAgentConfig } from "../../shared/config/agentRegistry.js";
import { AgentAvailabilityStore, getAgentAvailabilityStore } from "./AgentAvailabilityStore.js";
import type { AgentRoutingConfig, AgentDomainWeights } from "../../shared/types/agentSettings.js";
import { DEFAULT_ROUTING_CONFIG } from "../../shared/types/agentSettings.js";

/**
 * Routing hints provided when routing a task to an agent.
 */
export interface TaskRoutingHints {
  /** Capabilities the agent must have */
  requiredCapabilities?: string[];
  /** Domains where the agent should be strong */
  preferredDomains?: (keyof AgentDomainWeights)[];
  /** Task priority (affects scoring weight) */
  priority?: number;
  /** Specific worktree this task is tied to */
  worktreeId?: string;
}

/**
 * Score result for a candidate agent.
 */
export interface AgentScore {
  agentId: string;
  score: number;
  reasons: string[];
}

/**
 * Scoring weights for different factors.
 */
const SCORING_WEIGHTS = {
  /** Weight for domain match score (0-100 points) */
  DOMAIN: 100,
  /** Weight for load factor score (0-50 points) */
  LOAD: 50,
  /** Bonus for being available right now */
  AVAILABILITY_BONUS: 50,
  /** Small random factor to break ties */
  TIE_BREAKER_MAX: 5,
};

export class AgentRouter {
  constructor(private availabilityStore: AgentAvailabilityStore) {}

  /**
   * Find the best agent for a task using filter-score-select pipeline.
   * Returns null if no suitable agent is found.
   */
  async routeTask(hints: TaskRoutingHints = {}): Promise<string | null> {
    const scores = await this.scoreCandidates(hints);

    if (scores.length === 0) {
      return null;
    }

    return this.selectAgent(scores);
  }

  /**
   * Get scored candidates for a task.
   * Returns agents sorted by score (highest first).
   */
  async scoreCandidates(hints: TaskRoutingHints = {}): Promise<AgentScore[]> {
    const filteredAgentIds = this.filterAgents(hints);

    if (filteredAgentIds.length === 0) {
      return [];
    }

    const scores: AgentScore[] = [];

    for (const agentId of filteredAgentIds) {
      const score = this.scoreAgent(agentId, hints);
      scores.push(score);
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    return scores;
  }

  /**
   * Filter agents by required capabilities, enabled status, and availability.
   * Returns agent IDs that pass all filters.
   */
  private filterAgents(hints: TaskRoutingHints): string[] {
    const registry = getEffectiveRegistry();
    const candidates: string[] = [];

    for (const agentId of Object.keys(registry)) {
      const config = registry[agentId];
      const routing = config.routing ?? DEFAULT_ROUTING_CONFIG;

      // Check if routing is enabled
      if (!routing.enabled) {
        continue;
      }

      // Check required capabilities
      if (hints.requiredCapabilities && hints.requiredCapabilities.length > 0) {
        const agentCapabilities = new Set(routing.capabilities.map((c) => c.toLowerCase()));
        const hasAllRequired = hints.requiredCapabilities.every((req) =>
          agentCapabilities.has(req.toLowerCase())
        );

        if (!hasAllRequired) {
          continue;
        }
      }

      // Check if agent is in an available state (idle or waiting)
      const state = this.availabilityStore.getState(agentId);
      if (state && !this.availabilityStore.isAvailable(agentId)) {
        continue;
      }

      // Check availability (not over max concurrent)
      const concurrent = this.availabilityStore.getConcurrentTaskCount(agentId);
      const maxConcurrent = routing.maxConcurrent ?? 1;

      if (concurrent >= maxConcurrent) {
        continue;
      }

      candidates.push(agentId);
    }

    return candidates;
  }

  /**
   * Score an agent for a task based on domain weights, load, and availability.
   */
  private scoreAgent(agentId: string, hints: TaskRoutingHints): AgentScore {
    const config = getEffectiveAgentConfig(agentId);
    const routing = config?.routing ?? DEFAULT_ROUTING_CONFIG;
    const reasons: string[] = [];

    let score = 0;

    // Domain weight score (0-100)
    if (hints.preferredDomains && hints.preferredDomains.length > 0) {
      const domainWeights = hints.preferredDomains.map((domain) => {
        const weight = routing.domains?.[domain] ?? 0.5;
        return weight;
      });

      const avgWeight = domainWeights.reduce((a, b) => a + b, 0) / domainWeights.length;
      const domainScore = avgWeight * SCORING_WEIGHTS.DOMAIN;
      score += domainScore;
      reasons.push(`domain: ${domainScore.toFixed(1)} (avg weight: ${avgWeight.toFixed(2)})`);
    } else {
      // No preferred domains, give base score
      score += SCORING_WEIGHTS.DOMAIN * 0.5;
      reasons.push(`domain: ${(SCORING_WEIGHTS.DOMAIN * 0.5).toFixed(1)} (default)`);
    }

    // Load factor score (0-50): fewer concurrent tasks = higher score
    const concurrent = this.availabilityStore.getConcurrentTaskCount(agentId);
    const maxConcurrent = routing.maxConcurrent ?? 1;
    const rawLoadFactor = 1 - concurrent / maxConcurrent;
    const loadFactor = Math.max(0, Math.min(1, rawLoadFactor));
    const loadScore = loadFactor * SCORING_WEIGHTS.LOAD;
    score += loadScore;
    reasons.push(`load: ${loadScore.toFixed(1)} (${concurrent}/${maxConcurrent} tasks)`);

    // Availability bonus
    if (this.availabilityStore.isAvailable(agentId)) {
      score += SCORING_WEIGHTS.AVAILABILITY_BONUS;
      reasons.push(`available: +${SCORING_WEIGHTS.AVAILABILITY_BONUS}`);
    }

    // Small random tie-breaker
    const tieBreaker = Math.random() * SCORING_WEIGHTS.TIE_BREAKER_MAX;
    score += tieBreaker;

    return {
      agentId,
      score,
      reasons,
    };
  }

  /**
   * Select the best agent from scored candidates.
   * Uses top-scored selection (deterministic for testing).
   */
  private selectAgent(scores: AgentScore[]): string | null {
    if (scores.length === 0) {
      return null;
    }

    // Return the top-scored agent
    return scores[0].agentId;
  }

  /**
   * Check if any agent is capable of handling a task with given requirements.
   * Useful for pre-flight checks before task creation.
   */
  hasCapableAgent(hints: TaskRoutingHints = {}): boolean {
    const candidates = this.filterAgents(hints);
    return candidates.length > 0;
  }

  /**
   * Get the routing configuration for an agent.
   */
  getAgentRouting(agentId: string): AgentRoutingConfig {
    const config = getEffectiveAgentConfig(agentId);
    return config?.routing ?? DEFAULT_ROUTING_CONFIG;
  }
}

let routerInstance: AgentRouter | null = null;

/**
 * Get the singleton AgentRouter instance.
 */
export function getAgentRouter(): AgentRouter {
  if (!routerInstance) {
    routerInstance = new AgentRouter(getAgentAvailabilityStore());
  }
  return routerInstance;
}

/**
 * Initialize a new AgentRouter instance.
 * Disposes any existing instance.
 */
export function initializeAgentRouter(
  availabilityStore: AgentAvailabilityStore
): AgentRouter {
  routerInstance = new AgentRouter(availabilityStore);
  return routerInstance;
}

/**
 * Dispose the AgentRouter singleton.
 */
export function disposeAgentRouter(): void {
  routerInstance = null;
}
