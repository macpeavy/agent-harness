// The dispatch context's public surface — what the service layer (the loop daemon,
// the amend cycle) imports. The internal layering (model = engine, schema =
// persistence, repository = data access) stays behind this barrel.

export { DispatchRepository } from "./repository";
export type { CreateDispatch, SessionLinks, DispatchFilter } from "./repository";

export {
  TRANSITIONS,
  isTerminal,
  nonTerminalStates,
  DISPATCH_STATES,
  ESCALATIONS,
  COST_LEGS,
} from "./model";
export type { Dispatch, NewDispatch, DispatchState, Escalation, CostLeg } from "./model";
