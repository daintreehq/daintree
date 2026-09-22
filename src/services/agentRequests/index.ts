/**
 * Delivering requests to an agent terminal, honestly. Each owner's requests go
 * out one at a time, in the order they were made — a request sent while the
 * agent is busy waits its turn rather than replacing the one before it — and
 * only one request, from any owner, goes into a terminal at a time. For each:
 * an explicit destination, a launch without the prompt, readiness the host
 * actually observed, a prompt built when the request's turn comes and a
 * freshness check taken on either side of building it, and a receipt that never
 * rounds an ambiguous write up to "sent". Owners supply the subject, the prompt,
 * the freshness check and somewhere to put the state; the mechanics live here.
 */
export {
  cancelAgentRequest,
  cancelAgentRequests,
  deliverAgentRequest,
  forceAgentRequest,
  __resetAgentRequestsForTests,
  type AgentRequestDelivery,
  type AgentRequestDestination,
  type AgentRequestOptions,
} from "./deliverAgentRequest";
export { deliveryFromPhase, launchReadiness, type DeliveryState } from "./deliveryState";
