// The runtime context's public surface — what the service layer (the session loop's
// notify pass, the chief launcher) imports. The internal layering (schema = persistence,
// repository = data access) stays behind this barrel. No model.ts: registration is a
// stateless address, not a state machine.

export { RuntimeRepository } from "./repository";
export type { RegisterChief } from "./repository";
export type { ChiefRegistration, NewChiefRegistration } from "./schema";
