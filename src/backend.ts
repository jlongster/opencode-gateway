export * as GatewayBackend from "./backend.js";

import { Workspace } from "@opencode-ai/schema/workspace";
import { Context, Effect, Layer, Schema } from "effect";
import { GatewayModal } from "./modal.js";
import { GatewayRegistry } from "./registry.js";

export interface Connection {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()(
  "GatewayBackend.UnavailableError",
  {
    workspaceID: Workspace.ID,
    reason: Schema.String,
  },
) {}

export interface Interface {
  readonly connect: (
    workspaceID: Workspace.ID,
  ) => Effect.Effect<Connection, UnavailableError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Backend",
) {}

export const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* GatewayRegistry.Service;
    return Service.of({
      connect: Effect.fn("GatewayBackend.connect")(function* (workspaceID) {
        const sandbox = yield* registry.currentSandbox(workspaceID);
        if (!sandbox?.endpoint)
          return yield* new UnavailableError({
            workspaceID,
            reason: "workspace has no reachable sandbox endpoint",
          });
        return { url: sandbox.endpoint, headers: {} };
      }),
    });
  }),
);

export function modalLayer(options: {
  readonly port: number;
  readonly password: string;
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const registry = yield* GatewayRegistry.Service;
      const modal = yield* GatewayModal.Service;
      return Service.of({
        connect: Effect.fn("GatewayBackend.connect")(function* (workspaceID) {
          const sandbox = yield* registry.currentSandbox(workspaceID);
          if (!sandbox)
            return yield* new UnavailableError({
              workspaceID,
              reason: "workspace has no running sandbox",
            });
          const credentials = yield* modal
            .connect(sandbox.id, options.port)
            .pipe(
              Effect.mapError(
                (error) =>
                  new UnavailableError({
                    workspaceID,
                    reason: `failed to connect to sandbox: ${error.operation}`,
                  }),
              ),
            );
          const url = new URL(credentials.url);
          url.searchParams.set("_modal_connect_token", credentials.token);
          return {
            url: url.toString(),
            headers: {
              authorization: `Basic ${btoa(`opencode:${options.password}`)}`,
            },
          };
        }),
      });
    }),
  );
}
