import { afterEach, describe, expect, test } from "bun:test";
import { Workspace } from "@opencode-ai/schema/workspace";
import { Database } from "bun:sqlite";
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

  test("seeds images and transactionally binds workspace creation", async () => {
    const database = await databasePath();
    const result = await run(
      database,
      Effect.gen(function* () {
        const registry = yield* GatewayRegistry.Service;
        const invalid = yield* registry
          .createWorkspace({
            directory: "/persist/project",
            imageName: "missing",
          })
          .pipe(Effect.exit);
        const workspace = yield* registry.createWorkspace({
          directory: "/persist/project",
        });
        return {
          invalid,
          images: yield* registry.listImages,
          workspaces: yield* registry.listWorkspaces,
          binding: yield* registry.getWorkspaceImage(workspace.id),
        };
      }),
    );

    expect(Exit.isFailure(result.invalid)).toBe(true);
    expect(result.images.map((image) => [image.name, image.kind])).toEqual([
      ["default", "default"],
    ]);
    expect(result.workspaces).toHaveLength(1);
    expect(result.binding?.image.name).toBe("default");
  });

  test("backfills default image bindings for existing workspaces", async () => {
    const database = await databasePath();
    const sqlite = new Database(database);
    sqlite.run(`
      CREATE TABLE workspace (
        id TEXT PRIMARY KEY,
        volume_subpath TEXT NOT NULL UNIQUE,
        directory TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `);
    const workspaceID = Workspace.ID.create();
    sqlite
      .query("INSERT INTO workspace VALUES (?, ?, ?, ?, ?)")
      .run(workspaceID, `/workspaces/${workspaceID}`, "/persist/project", 1, 2);
    sqlite.close();

    const binding = await run(
      database,
      Effect.gen(function* () {
        const registry = yield* GatewayRegistry.Service;
        return yield* registry.getWorkspaceImage(workspaceID);
      }),
    );
    expect(binding?.image.name).toBe("default");
    expect(binding?.timeUpdated).toBe(2);
  });

  test("stores immutable snapshot images and allocates the next generation", async () => {
    const database = await databasePath();
    const result = await run(
      database,
      Effect.gen(function* () {
        const registry = yield* GatewayRegistry.Service;
        const workspace = yield* registry.createWorkspace({
          directory: "/persist/project",
        });
        yield* registry.registerSandbox({
          id: "sb_source",
          workspaceID: workspace.id,
          generation: 3,
          status: "running",
          timeCreated: 1,
        });
        const image = yield* registry.createSnapshotImage({
          name: "node-tools",
          imageID: "im_first",
          sourceWorkspaceID: workspace.id,
          sourceSandboxID: "sb_source",
          sourceGeneration: 3,
          timeCreated: 10,
        });
        const duplicate = yield* registry
          .createSnapshotImage({
            name: "node-tools",
            imageID: "im_second",
            sourceWorkspaceID: workspace.id,
            sourceSandboxID: "sb_source",
            sourceGeneration: 3,
            timeCreated: 11,
          })
          .pipe(Effect.exit);
        const invalid = yield* registry
          .createSnapshotImage({
            name: "Invalid",
            imageID: "im_invalid",
            sourceWorkspaceID: workspace.id,
            sourceSandboxID: "sb_source",
            sourceGeneration: 3,
            timeCreated: 12,
          })
          .pipe(Effect.exit);
        return {
          image,
          duplicate,
          invalid,
          binding: yield* registry.getWorkspaceImage(workspace.id),
          generation: yield* registry.nextSandboxGeneration(workspace.id),
        };
      }),
    );

    expect(result.image).toMatchObject({
      name: "node-tools",
      kind: "snapshot",
      imageID: "im_first",
      sourceGeneration: 3,
    });
    expect(Exit.isFailure(result.duplicate)).toBe(true);
    expect(Exit.isFailure(result.invalid)).toBe(true);
    expect(result.binding?.image.imageID).toBe("im_first");
    expect(result.generation).toBe(4);
  });

  test("correlates and atomically claims durable tool calls", async () => {
    const database = await databasePath();
    const created = await run(
      database,
      Effect.gen(function* () {
        const registry = yield* GatewayRegistry.Service;
        const workspace = yield* registry.createWorkspace({
          directory: "/persist/project",
        });
        yield* registry.registerSandbox({
          id: "sb_tools",
          workspaceID: workspace.id,
          generation: 1,
          status: "running",
          timeCreated: 1,
        });
        yield* registry.recordToolInput({
          sandboxID: "sb_tools",
          workspaceID: workspace.id,
          sessionID: "ses_tools",
          assistantMessageID: "msg_tools",
          toolCallID: "call_snapshot",
          tool: "gateway_image_snapshot",
          time: 2,
        });
        const correlated = yield* registry.correlateToolCall({
          sandboxID: "sb_tools",
          toolCallID: "call_snapshot",
          input: { name: "rust-tools" },
          time: 3,
        });
        const claim = yield* registry.claimToolCall(
          "sb_tools",
          "call_snapshot",
          4,
        );
        const replay = yield* registry.claimToolCall(
          "sb_tools",
          "call_snapshot",
          5,
        );
        const succeeded = yield* registry.succeedToolCall({
          sandboxID: "sb_tools",
          toolCallID: "call_snapshot",
          result: { imageID: "im_rust" },
          time: 6,
          image: {
            name: "rust-tools",
            imageID: "im_rust",
            sourceWorkspaceID: workspace.id,
            sourceSandboxID: "sb_tools",
            sourceGeneration: 1,
            timeCreated: 6,
          },
        });
        yield* registry.recordToolInput({
          sandboxID: "sb_tools",
          workspaceID: workspace.id,
          sessionID: "ses_tools",
          assistantMessageID: "msg_tools",
          toolCallID: "call_failed",
          tool: "gateway_image_snapshot",
          time: 7,
        });
        yield* registry.claimToolCall("sb_tools", "call_failed", 8);
        const failed = yield* registry.failToolCall({
          sandboxID: "sb_tools",
          toolCallID: "call_failed",
          error: { message: "snapshot failed" },
          time: 9,
        });
        return { correlated, claim, replay, succeeded, failed, workspace };
      }),
    );

    expect(created.correlated?.input).toEqual({ name: "rust-tools" });
    expect(created.claim?.status).toBe("running");
    expect(created.replay).toBeUndefined();
    expect(created.succeeded?.status).toBe("succeeded");
    expect(created.failed).toMatchObject({
      status: "failed",
      result: { message: "snapshot failed" },
    });

    const restored = await run(
      database,
      Effect.gen(function* () {
        const registry = yield* GatewayRegistry.Service;
        return {
          call: yield* registry.findToolCall("sb_tools", "call_snapshot"),
          binding: yield* registry.getWorkspaceImage(created.workspace.id),
        };
      }),
    );
    expect(restored.call?.result).toEqual({ imageID: "im_rust" });
    expect(restored.binding?.image.name).toBe("rust-tools");
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
          flushPersist: () => Effect.die(new Error("not used")),
          snapshotFilesystem: () => Effect.die(new Error("not used")),
          writeToolResponse: () => Effect.die(new Error("not used")),
          deleteImage: () => Effect.die(new Error("not used")),
          running: () => Effect.die(new Error("not used")),
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
