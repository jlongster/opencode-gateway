export * as GatewayProvision from "./provision.js";

import { Agent } from "@opencode-ai/schema/agent";
import { Model } from "@opencode-ai/schema/model";
import { Location } from "@opencode-ai/schema/location";
import { Session } from "@opencode-ai/schema/session";
import { Workspace } from "@opencode-ai/schema/workspace";
import { AbsolutePath } from "@opencode-ai/schema/schema";
import { Context, DateTime, Effect, Layer, Schema, Semaphore } from "effect";
import { HttpClient } from "effect/unstable/http";
import { GatewayBackend } from "./backend.js";
import { GatewayClient } from "./client.js";
import { GatewayCredentials } from "./credentials.js";
import { GatewayEvents } from "./events.js";
import { GatewayImage } from "./image.js";
import { GatewayModal } from "./modal.js";
import { GatewayRegistry } from "./registry.js";

export const Input = Schema.Struct({
  id: Schema.optional(Session.ID),
  title: Schema.optional(Schema.String),
  agent: Schema.optional(Agent.ID),
  model: Schema.optional(Model.Ref),
  location: Schema.optional(Location.Ref),
});
export type Input = typeof Input.Type;

export class ProvisionError extends Schema.TaggedErrorClass<ProvisionError>()(
  "GatewayProvision.ProvisionError",
  {
    cause: Schema.Defect(),
  },
) {}

export interface Interface {
  readonly create: (
    input: Input,
  ) => Effect.Effect<Session.Info, ProvisionError>;
  readonly resume: (
    workspaceID: Workspace.ID,
  ) => Effect.Effect<void, ProvisionError>;
  readonly terminate: (
    workspaceID: Workspace.ID,
  ) => Effect.Effect<void, ProvisionError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Provision",
) {}

export function layer(options: {
  readonly root: string;
  readonly upstreamPassword: string;
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const registry = yield* GatewayRegistry.Service;
      const modal = yield* GatewayModal.Service;
      const backend = yield* GatewayBackend.Service;
      const credentials = yield* GatewayCredentials.Service;
      const events = yield* GatewayEvents.Service;
      const httpClient = yield* HttpClient.HttpClient;
      const locks = new Map<string, Semaphore.Semaphore>();
      const lock = (workspaceID: string) => {
        const existing = locks.get(workspaceID);
        if (existing) return existing;
        const created = Semaphore.makeUnsafe(1);
        locks.set(workspaceID, created);
        return created;
      };

      const existing = Effect.fnUntraced(function* (sessionID: Session.ID) {
        const binding = yield* registry.findSession(sessionID);
        if (!binding) return undefined;
        const connection = yield* backend.connect(binding.workspaceID);
        const client = yield* GatewayClient.make(connection, httpClient);
        const session = yield* client.session.get({ sessionID });
        return {
          ...session,
          location: { ...session.location, workspaceID: binding.workspaceID },
        };
      });

      const create = Effect.fn("GatewayProvision.create")((input: Input) =>
        Effect.gen(function* () {
          if (input.id) {
            const recorded = yield* existing(input.id);
            if (recorded) return recorded;
          }
          const requestedImage = GatewayImage.candidate(
            input.location?.directory,
            options.root,
          );
          const requested = yield* registry.findImage(requestedImage);
          const imageName = requested
            ? requestedImage
            : GatewayImage.DefaultName;
          const image = requested ?? (yield* registry.findImage(imageName));
          if (!image)
            return yield* new GatewayRegistry.ImageNotFoundError({
              name: imageName,
            });
          const installationID = yield* registry.installationID;
          const workspace = yield* registry.createWorkspace({
            directory: options.root,
            imageName,
          });
          const sandbox = yield* modal
            .create({
              installationID,
              workspaceID: workspace.id,
              generation: 1,
              volumeSubpath: workspace.volumeSubpath,
              root: options.root,
              upstreamPassword: options.upstreamPassword,
              credentials: credentials.snapshot,
              imageID: image.imageID,
            })
            .pipe(Effect.onError(() => registry.removeWorkspace(workspace.id)));
          return yield* Effect.gen(function* () {
            yield* registry.registerSandbox({
              id: sandbox.id,
              workspaceID: workspace.id,
              generation: 1,
              status: "running",
              timeCreated: Date.now(),
            });
            yield* events.watch(workspace.id);
            const connection = yield* backend.connect(workspace.id);
            const client = yield* GatewayClient.make(connection, httpClient);
            const session = yield* client.session.create({
              ...input,
              location: { directory: AbsolutePath.make(options.root) },
            });
            yield* registry.registerProject({
              workspaceID: workspace.id,
              projectID: session.projectID,
              directory: session.location.directory,
              canonical: session.location.directory,
              time: DateTime.toEpochMillis(session.time.updated),
            });
            yield* registry.registerSession({
              id: session.id,
              workspaceID: workspace.id,
              projectID: session.projectID,
              parentID: session.parentID,
              timeCreated: DateTime.toEpochMillis(session.time.created),
              timeUpdated: DateTime.toEpochMillis(session.time.updated),
              info: {
                ...session,
                location: { ...session.location, workspaceID: workspace.id },
              },
            });
            return {
              ...session,
              location: { ...session.location, workspaceID: workspace.id },
            };
          }).pipe(
            Effect.onError(() =>
              Effect.all(
                [
                  modal.terminate(sandbox.id).pipe(Effect.ignore),
                  registry.removeWorkspace(workspace.id),
                ],
                {
                  discard: true,
                },
              ),
            ),
          );
        }).pipe(Effect.mapError((cause) => new ProvisionError({ cause }))),
      );

      const resume = Effect.fn("GatewayProvision.resume")((workspaceID) =>
        lock(workspaceID).withPermits(1)(
          Effect.gen(function* () {
            const current = yield* registry.currentSandbox(workspaceID);
            if (current) {
              if (yield* modal.running(current.id)) return;
              yield* registry.finishSandbox(current.id, "missing", Date.now());
            }
            const workspace = yield* registry.getWorkspace(workspaceID);
            if (!workspace)
              return yield* new GatewayRegistry.WorkspaceNotFoundError({
                workspaceID,
              });
            const selected = yield* registry.getWorkspaceImage(workspaceID);
            if (!selected)
              return yield* new GatewayRegistry.ImageNotFoundError({
                name: GatewayImage.DefaultName,
              });
            const installationID = yield* registry.installationID;
            const generation =
              yield* registry.nextSandboxGeneration(workspaceID);
            const sandbox = yield* modal.create({
              installationID,
              workspaceID,
              generation,
              volumeSubpath: workspace.volumeSubpath,
              root: options.root,
              upstreamPassword: options.upstreamPassword,
              credentials: credentials.snapshot,
              imageID: selected.image.imageID,
            });
            yield* registry.registerSandbox({
              id: sandbox.id,
              workspaceID,
              generation,
              status: "running",
              timeCreated: Date.now(),
            });
            yield* events.watch(workspaceID);
          }).pipe(Effect.mapError((cause) => new ProvisionError({ cause }))),
        ),
      );

      const terminate = Effect.fn("GatewayProvision.terminate")((workspaceID) =>
        lock(workspaceID).withPermits(1)(
          Effect.gen(function* () {
            const sandbox = yield* registry.currentSandbox(workspaceID);
            if (!sandbox) return;
            yield* modal.deleteDatabase(sandbox.id);
            yield* modal.terminate(sandbox.id);
            yield* registry.finishSandbox(sandbox.id, "finished", Date.now());
          }).pipe(Effect.mapError((cause) => new ProvisionError({ cause }))),
        ),
      );

      return Service.of({ create, resume, terminate });
    }),
  );
}
