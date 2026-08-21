export * as GatewayReconcile from "./reconcile.js";

import { Workspace } from "@opencode-ai/schema/workspace";
import { Effect, Option, Schema } from "effect";
import { GatewayModal } from "./modal.js";
import { GatewayRegistry } from "./registry.js";

const decodeWorkspaceID = Schema.decodeUnknownOption(Workspace.ID);
const Generation = Schema.NumberFromString.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThan(0))),
);
const decodeGeneration = Schema.decodeUnknownOption(Generation);

export interface Result {
  readonly discovered: number;
  readonly registered: number;
  readonly quarantined: number;
}

export const run = Effect.fn("GatewayReconcile.run")(function* () {
  const modal = yield* GatewayModal.Service;
  const registry = yield* GatewayRegistry.Service;
  const installationID = yield* registry.installationID;
  const discovered = yield* modal.listOwned(installationID);
  const results = yield* Effect.forEach(
    discovered,
    (sandbox) => reconcile(sandbox, installationID),
    {
      concurrency: 8,
    },
  );
  const activeIDs = new Set(
    discovered.flatMap((sandbox, index) =>
      results[index] === "registered" ? [sandbox.id] : [],
    ),
  );
  yield* registry.markMissingSandboxes(activeIDs, Date.now());
  return {
    discovered: discovered.length,
    registered: results.filter((result) => result === "registered").length,
    quarantined: results.filter((result) => result === "quarantined").length,
  } satisfies Result;
});

function reconcile(
  sandbox: {
    readonly id: string;
    readonly tags: Readonly<Record<string, string>>;
  },
  installationID: string,
) {
  return Effect.gen(function* () {
    const registry = yield* GatewayRegistry.Service;
    if (sandbox.tags[GatewayModal.GatewayTag] !== installationID)
      return yield* quarantine(sandbox, "gateway ownership tag does not match");
    const workspaceID = decodeWorkspaceID(
      sandbox.tags[GatewayModal.WorkspaceTag],
    );
    if (Option.isNone(workspaceID))
      return yield* quarantine(sandbox, "workspace tag is missing or invalid");
    const generation = decodeGeneration(
      sandbox.tags[GatewayModal.GenerationTag],
    );
    if (Option.isNone(generation))
      return yield* quarantine(sandbox, "generation tag is missing or invalid");
    const workspace = yield* registry.getWorkspace(workspaceID.value);
    if (!workspace)
      return yield* quarantine(
        sandbox,
        "workspace is not registered by this gateway",
      );
    return yield* registry
      .registerSandbox({
        id: sandbox.id,
        workspaceID: workspaceID.value,
        generation: generation.value,
        status: "running",
        timeCreated: Date.now(),
      })
      .pipe(
        Effect.as("registered" as const),
        Effect.catchTag("GatewayRegistry.OwnershipConflictError", () =>
          quarantine(
            sandbox,
            "sandbox ownership conflicts with the gateway registry",
          ),
        ),
      );
  });
}

function quarantine(
  sandbox: {
    readonly id: string;
    readonly tags: Readonly<Record<string, string>>;
  },
  reason: string,
) {
  return Effect.gen(function* () {
    const registry = yield* GatewayRegistry.Service;
    yield* registry.quarantine({
      sandboxID: sandbox.id,
      reason,
      tags: sandbox.tags,
      time: Date.now(),
    });
    return "quarantined" as const;
  });
}
