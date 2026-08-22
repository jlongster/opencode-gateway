export * as GatewayTools from "./tools.js";

import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event";
import { Cause, Context, Effect, Layer, Scope, Semaphore } from "effect";
import { AbsolutePath } from "@opencode-ai/schema/schema";
import { GatewayImage } from "./image.js";
import { GatewayModal } from "./modal.js";
import { GatewayProvision } from "./provision.js";
import { GatewayRegistry } from "./registry.js";

const SnapshotTool = "gateway_image_snapshot";
const ImageListTool = "gateway_image_list";
const SessionCreateTool = "gateway_session_create";
const supported: ReadonlySet<string> = new Set([
  SnapshotTool,
  ImageListTool,
  SessionCreateTool,
]);

export interface Interface {
  readonly observe: (
    event: OpenCodeEvent,
    source: GatewayRegistry.SandboxInfo,
  ) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Tools",
) {}

export function layer(options: {
  readonly provision: Effect.Effect<GatewayProvision.Interface>;
  readonly root: string;
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const registry = yield* GatewayRegistry.Service;
      const modal = yield* GatewayModal.Service;
      const scope = yield* Scope.Scope;
      const locks = new Map<string, Semaphore.Semaphore>();
      const lock = (workspaceID: string) => {
        const existing = locks.get(workspaceID);
        if (existing) return existing;
        const created = Semaphore.makeUnsafe(1);
        locks.set(workspaceID, created);
        return created;
      };

      const respond = (sandboxID: string, callID: string, response: unknown) =>
        modal.writeToolResponse(sandboxID, callID, response).pipe(
          Effect.catch((error) =>
            Effect.logError("failed to write gateway tool response", {
              sandboxID,
              callID,
              error,
            }),
          ),
        );

      const replay = Effect.fnUntraced(function* (
        call: GatewayRegistry.GatewayToolCall,
      ) {
        const existing = yield* registry.findToolCall(
          call.sandboxID,
          call.toolCallID,
        );
        if (existing?.status === "succeeded")
          yield* respond(existing.sandboxID, existing.toolCallID, {
            ok: true,
            result: existing.result,
          });
        if (existing?.status === "failed")
          yield* respond(existing.sandboxID, existing.toolCallID, {
            ok: false,
            error: errorText(existing.result),
          });
      });

      const executeSnapshot = Effect.fn("GatewayTools.executeSnapshot")(
        function* (
          call: GatewayRegistry.GatewayToolCall,
          source: GatewayRegistry.SandboxInfo,
        ) {
          const claimed = yield* registry.claimToolCall(
            call.sandboxID,
            call.toolCallID,
            Date.now(),
          );
          if (!claimed) {
            yield* replay(call);
            return;
          }

          let createdImageID: string | undefined;
          const operation = lock(call.workspaceID).withPermits(1)(
            Effect.gen(function* () {
              const name = snapshotName(claimed.input);
              const description = snapshotDescription(claimed.input);
              if (!name || !GatewayRegistry.ImageNamePattern.test(name))
                return yield* Effect.fail(
                  new Error("Image name must match [a-z0-9][a-z0-9._-]{0,63}"),
                );
              if (!description)
                return yield* Effect.fail(
                  new Error("Image description is required"),
                );
              const current = yield* registry.currentSandbox(call.workspaceID);
              if (
                !current ||
                current.id !== source.id ||
                current.generation !== source.generation
              )
                return yield* Effect.fail(
                  new Error("The source sandbox is no longer authoritative"),
                );
              if (yield* registry.findImage(name))
                return yield* new GatewayRegistry.ImageNameConflictError({
                  name,
                });

              const started = Date.now();
              yield* Effect.logInfo("gateway image snapshot started", {
                workspaceID: call.workspaceID,
                sandboxID: source.id,
                generation: source.generation,
                callID: call.toolCallID,
                name,
              });
              yield* modal.flushFilesystem(source.id);
              yield* Effect.logInfo("gateway image snapshot volume flushed", {
                workspaceID: call.workspaceID,
                sandboxID: source.id,
                callID: call.toolCallID,
                elapsedMs: Date.now() - started,
              });
              createdImageID = yield* modal.snapshotFilesystem(source.id);
              const result = {
                tool: SnapshotTool,
                workspaceID: call.workspaceID,
                sandboxID: source.id,
                name,
                description,
                imageID: createdImageID,
                generation: source.generation,
                durationMs: Date.now() - started,
              };
              yield* registry.succeedToolCall({
                sandboxID: source.id,
                toolCallID: call.toolCallID,
                result,
                time: Date.now(),
                image: {
                  name,
                  description,
                  imageID: createdImageID,
                  sourceWorkspaceID: call.workspaceID,
                  sourceSandboxID: source.id,
                  sourceGeneration: source.generation,
                  timeCreated: Date.now(),
                },
              });
              createdImageID = undefined;
              yield* respond(source.id, call.toolCallID, { ok: true, result });
              yield* Effect.logInfo("gateway image snapshot finished", {
                workspaceID: call.workspaceID,
                sandboxID: source.id,
                callID: call.toolCallID,
                name,
                imageID: result.imageID,
                durationMs: result.durationMs,
              });
            }),
          );

          yield* operation.pipe(
            Effect.catchCause((cause) => {
              const error = Cause.pretty(cause);
              return Effect.gen(function* () {
                if (createdImageID)
                  yield* modal.deleteImage(createdImageID).pipe(Effect.ignore);
                yield* registry.failToolCall({
                  sandboxID: source.id,
                  toolCallID: call.toolCallID,
                  error,
                  time: Date.now(),
                });
                yield* respond(source.id, call.toolCallID, {
                  ok: false,
                  error,
                });
                yield* Effect.logError("gateway image snapshot failed", {
                  workspaceID: call.workspaceID,
                  sandboxID: source.id,
                  callID: call.toolCallID,
                  error,
                });
              });
            }),
          );
        },
      );

      const executeSimple = Effect.fn("GatewayTools.executeSimple")(function* (
        call: GatewayRegistry.GatewayToolCall,
        operation: (
          claimed: GatewayRegistry.GatewayToolCall,
        ) => Effect.Effect<unknown, unknown>,
      ) {
        const claimed = yield* registry.claimToolCall(
          call.sandboxID,
          call.toolCallID,
          Date.now(),
        );
        if (!claimed) {
          yield* replay(call);
          return;
        }
        yield* operation(claimed).pipe(
          Effect.flatMap((result) =>
            registry
              .succeedToolCall({
                sandboxID: claimed.sandboxID,
                toolCallID: claimed.toolCallID,
                result,
                time: Date.now(),
              })
              .pipe(
                Effect.andThen(
                  respond(claimed.sandboxID, claimed.toolCallID, {
                    ok: true,
                    result,
                  }),
                ),
              ),
          ),
          Effect.catchCause((cause) => {
            const error = Cause.pretty(cause);
            return registry
              .failToolCall({
                sandboxID: claimed.sandboxID,
                toolCallID: claimed.toolCallID,
                error,
                time: Date.now(),
              })
              .pipe(
                Effect.andThen(
                  respond(claimed.sandboxID, claimed.toolCallID, {
                    ok: false,
                    error,
                  }),
                ),
              );
          }),
        );
      });

      const executeImageList = (call: GatewayRegistry.GatewayToolCall) =>
        executeSimple(call, () =>
          registry.listImages.pipe(
            Effect.map((images) => ({
              images: images.map(({ name, description, kind }) => ({
                name,
                description,
                kind,
              })),
            })),
          ),
        );

      const executeSessionCreate = (call: GatewayRegistry.GatewayToolCall) =>
        executeSimple(call, (claimed) =>
          Effect.gen(function* () {
            const input = sessionCreateInput(claimed.input);
            if (!input)
              return yield* Effect.fail(new Error("Image is required"));
            if (!(yield* registry.findImage(input.image)))
              return yield* new GatewayRegistry.ImageNotFoundError({
                name: input.image,
              });
            const provision = yield* options.provision;
            const session = yield* provision.create({
              ...(input.title ? { title: input.title } : {}),
              location: {
                directory: AbsolutePath.make(options.root),
                workspaceID: GatewayImage.workspace(input.image),
              },
            });
            return {
              tool: SessionCreateTool,
              image: input.image,
              sessionID: session.id,
              workspaceID: session.location.workspaceID,
              title: session.title,
            };
          }),
        );

      const observe = Effect.fn("GatewayTools.observe")(function* (
        event: OpenCodeEvent,
        source: GatewayRegistry.SandboxInfo,
      ) {
        if (
          event.type === "session.tool.input.started" &&
          supported.has(event.data.name)
        ) {
          yield* registry.recordToolInput({
            sandboxID: source.id,
            workspaceID: source.workspaceID,
            sessionID: event.data.sessionID,
            assistantMessageID: event.data.assistantMessageID,
            toolCallID: event.data.id,
            tool: event.data.name,
            time: Date.now(),
          });
          return;
        }
        if (event.type !== "session.tool.called") return;
        const call = yield* registry.correlateToolCall({
          sandboxID: source.id,
          toolCallID: event.data.id,
          input: event.data.input,
          time: Date.now(),
        });
        if (!call || !supported.has(call.tool)) return;
        const operation =
          call.tool === SnapshotTool
            ? executeSnapshot(call, source)
            : call.tool === ImageListTool
              ? executeImageList(call)
              : executeSessionCreate(call);
        yield* operation.pipe(Effect.forkIn(scope));
      });

      return Service.of({ observe });
    }),
  );
}

function snapshotName(input: unknown) {
  if (typeof input !== "object" || input === null || !("name" in input)) return;
  return typeof input.name === "string" ? input.name : undefined;
}

function snapshotDescription(input: unknown) {
  if (typeof input !== "object" || input === null || !("description" in input))
    return;
  return typeof input.description === "string" && input.description.trim()
    ? input.description.trim()
    : undefined;
}

function sessionCreateInput(input: unknown) {
  if (
    typeof input !== "object" ||
    input === null ||
    !("image" in input) ||
    typeof input.image !== "string"
  )
    return;
  const title =
    "title" in input && typeof input.title === "string"
      ? input.title.trim()
      : undefined;
  return { image: input.image, title: title || undefined };
}

function errorText(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return "Gateway operation failed";
}
