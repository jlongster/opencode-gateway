import { afterEach, describe, expect, test } from "bun:test";
import { Workspace } from "@opencode-ai/schema/workspace";
import { Effect, Exit, Layer } from "effect";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { GatewayDatabase } from "../src/database";
import { GatewayModal } from "../src/modal";
import { GatewayReconcile } from "../src/reconcile";
import { GatewayRegistry } from "../src/registry";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databasePath() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-gateway-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "gateway.db");
}

function layer(database: string) {
  return GatewayRegistry.layer.pipe(
    Layer.provide(GatewayDatabase.layer({ path: database })),
  );
}

function run<A, E>(
  database: string,
  effect: Effect.Effect<A, E, GatewayRegistry.Service>,
) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(layer(database)), Effect.scoped),
  );
}

describe("GatewayRegistry", () => {
  test("preserves installation and workspace identity across restarts", async () => {
    const database = await databasePath();
    const created = await run(
      database,
      Effect.gen(function* () {
        const registry = yield* GatewayRegistry.Service;
        const installationID = yield* registry.installationID;
        const workspace = yield* registry.createWorkspace({
          directory: "/persist/project",
        });
        yield* registry.registerSession({
          id: "ses_first",
          workspaceID: workspace.id,
          projectID: "project",
          timeCreated: 1,
          timeUpdated: 1,
        });
        return { installationID, workspace };
      }),
    );

    const restored = await run(
      database,
      Effect.gen(function* () {
        const registry = yield* GatewayRegistry.Service;
        return {
          installationID: yield* registry.installationID,
          workspaces: yield* registry.listWorkspaces,
          session: yield* registry.findSession("ses_first"),
        };
      }),
    );

    expect(restored.installationID).toBe(created.installationID);
    expect(restored.workspaces).toEqual([created.workspace]);
    expect(restored.session?.workspaceID).toBe(created.workspace.id);
  });

  test("registers multiple sessions in one workspace and rejects cross-workspace reuse", async () => {
    const database = await databasePath();
    const result = await run(
      database,
      Effect.gen(function* () {
        const registry = yield* GatewayRegistry.Service;
        const first = yield* registry.createWorkspace({
          directory: "/persist/project",
        });
        const second = yield* registry.createWorkspace({
          directory: "/persist/project",
        });
        yield* registry.registerSession({
          id: "ses_root",
          workspaceID: first.id,
          projectID: "same-project",
          timeCreated: 1,
          timeUpdated: 1,
        });
        yield* registry.registerSession({
          id: "ses_child",
          workspaceID: first.id,
          projectID: "same-project",
          parentID: "ses_root",
          timeCreated: 2,
          timeUpdated: 2,
        });
        const conflict = yield* registry
          .registerSession({
            id: "ses_root",
            workspaceID: second.id,
            projectID: "same-project",
            timeCreated: 1,
            timeUpdated: 3,
          })
          .pipe(Effect.exit);
        return { first, sessions: yield* registry.listSessions, conflict };
      }),
    );

    expect(result.sessions.map((session) => session.id)).toEqual([
      "ses_child",
      "ses_root",
    ]);
    expect(
      result.sessions.every(
        (session) => session.workspaceID === result.first.id,
      ),
    ).toBe(true);
    expect(Exit.isFailure(result.conflict)).toBe(true);
  });

  test("reconciles owned sandboxes and quarantines unknown workspaces", async () => {
    const database = await databasePath();
    const result = await run(
      database,
      Effect.gen(function* () {
        const registry = yield* GatewayRegistry.Service;
        const installationID = yield* registry.installationID;
        const workspace = yield* registry.createWorkspace({
          directory: "/persist/project",
        });
        yield* registry.registerSandbox({
          id: "sb_old",
          workspaceID: workspace.id,
          generation: 1,
          status: "running",
          timeCreated: 1,
        });
        const unknown = Workspace.ID.create();
        const modal = GatewayModal.Service.of({
          appID: "ap_test",
          volumeID: "vo_test",
          connect: () => Effect.die(new Error("not used")),
          create: () => Effect.die(new Error("not used")),
          terminate: () => Effect.die(new Error("not used")),
          listOwned: () =>
            Effect.succeed([
              {
                id: "sb_current",
                tags: {
                  [GatewayModal.GatewayTag]: installationID,
                  [GatewayModal.WorkspaceTag]: workspace.id,
                  [GatewayModal.GenerationTag]: "2",
                },
              },
              {
                id: "sb_unknown",
                tags: {
                  [GatewayModal.GatewayTag]: installationID,
                  [GatewayModal.WorkspaceTag]: unknown,
                  [GatewayModal.GenerationTag]: "1",
                },
              },
            ]),
        });
        const summary = yield* GatewayReconcile.run().pipe(
          Effect.provideService(GatewayModal.Service, modal),
        );
        return {
          summary,
          sandboxes: yield* registry.listSandboxes,
          quarantined: yield* registry.listQuarantined,
        };
      }),
    );

    expect(result.summary).toEqual({
      discovered: 2,
      registered: 1,
      quarantined: 1,
    });
    expect(
      result.sandboxes.map((sandbox) => [sandbox.id, sandbox.status]),
    ).toEqual([
      ["sb_old", "missing"],
      ["sb_current", "running"],
    ]);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.sandboxID).toBe("sb_unknown");
  });
});
