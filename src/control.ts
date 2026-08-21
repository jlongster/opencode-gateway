export * as GatewayControl from "./control.js";

import { Context, Layer } from "effect";
import type { Connection } from "./backend.js";

export interface Interface {
  readonly connection: Connection;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Control",
) {}

export function layer(connection: Connection) {
  return Layer.succeed(Service, Service.of({ connection }));
}
