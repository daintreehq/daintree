/**
 * Delivering one request to an agent terminal, honestly: an explicit
 * destination, a launch without the prompt, readiness the host actually
 * observed, a freshness check taken twice, and a receipt that never rounds an
 * ambiguous write up to "sent". Owners supply the subject, the prompt, the
 * freshness check and somewhere to put the state; the mechanics live here.
 */
export {
  cancelAgentRequests,
  deliverAgentRequest,
  forceAgentRequest,
  __resetAgentRequestsForTests,
  type AgentRequestDelivery,
  type AgentRequestDestination,
  type AgentRequestOptions,
} from "./deliverAgentRequest";
export { deliveryFromPhase, launchReadiness, type DeliveryState } from "./deliveryState";
