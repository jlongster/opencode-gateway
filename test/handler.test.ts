import { afterEach, describe, expect, test } from "bun:test";
import type { OpenCodeEvent } from "@opencode-ai/client/effect";
import { Event } from "@opencode-ai/schema/event";
import { Project } from "@opencode-ai/schema/project";
import { AbsolutePath } from "@opencode-ai/schema/schema";
import { Session } from "@opencode-ai/schema/session";
import { Workspace } from "@opencode-ai/schema/workspace";
import { DateTime, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { GatewayAggregate } from "../src/aggregate";
import { GatewayBackend } from "../src/backend";
import { GatewayControl } from "../src/control";
import { GatewayDatabase } from "../src/database";
import { GatewayEvents } from "../src/events";
import { GatewayHandler } from "../src/handler";
import { GatewayProcess } from "../src/process";
import { GatewayProvision } from "../src/provision";
import { GatewayRegistry } from "../src/registry";
import { GatewayTools } from "../src/tools";

const temporaryDirectories: string[] = [];
const password = "gateway-secret";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databasePath() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencode-gateway-handler-"),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, "gateway.db");
}

function authenticated(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Basic ${btoa(`opencode:${password}`)}`);
  return new Request(url, { ...init, headers });
}

function services(
  databasePath: string,
  controlURL = "http://127.0.0.1:1",
  provisionService: GatewayProvision.Interface = GatewayProvision.Service.of({
    create: () => Effect.die(new Error("not used")),
    resume: () => Effect.die(new Error("not used")),
    terminate: () => Effect.die(new Error("not used")),
  }),
) {
  const database = GatewayDatabase.layer({ path: databasePath });
  const registry = GatewayRegistry.layer.pipe(Layer.provide(database));
  const backend = GatewayBackend.registryLayer.pipe(Layer.provide(registry));
  const upstream = Layer.mergeAll(registry, backend, FetchHttpClient.layer);
  const aggregate = GatewayAggregate.layer.pipe(Layer.provide(upstream));
  const tools = Layer.succeed(
    GatewayTools.Service,
    GatewayTools.Service.of({ observe: () => Effect.void }),
  );
  const events = GatewayEvents.layer().pipe(
    Layer.provide(Layer.merge(upstream, tools)),
  );
  const provision = Layer.succeed(GatewayProvision.Service, provisionService);
  const control = GatewayControl.layer({ url: controlURL, headers: {} });
  return Layer.mergeAll(upstream, aggregate, tools, events, provision, control);
}

describe("GatewayHandler", () => {
  test("routes session and workspace requests to their owning backends", async () => {
    const firstRequests = { count: 0 };
    const secondRequests = { count: 0 };
    using first = Bun.serve({
      port: 0,
      fetch: async (request) => {
        firstRequests.count++;
        const url = new URL(request.url);
        if (url.pathname === "/api/model")
          return Response.json({
            location: {
              directory: "/persist/project",
              project: {
                id: "same-project",
                directory: "/persist/project",
                canonical: "/persist/project",
              },
            },
            data: [],
          });
        if (url.pathname === "/api/session/ses_first")
          return Response.json({
            data: {
              id: "ses_first",
              projectID: "same-project",
              location: { directory: "/persist/project" },
            },
          });
        if (url.pathname === "/api/shell" && request.method === "GET")
          return Response.json({
            location: {
              directory: "/persist/project",
              project: {
                id: "same-project",
                directory: "/persist/project",
                canonical: "/persist/project",
              },
            },
            data: [{ id: "sh_first", command: "echo hello" }],
          });
        if (url.pathname === "/api/session" && request.method === "GET")
          return Response.json({
            data: [sessionInfo("ses_first")],
            cursor: {},
          });
        if (url.pathname === "/api/session/active")
          return Response.json({ data: { ses_first: { type: "running" } } });
        if (url.pathname === "/api/fs/read/checkpoint.txt")
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "application/octet-stream" },
          });
        if (url.pathname === "/api/mcp/server/connect")
          return new Response(undefined, { status: 204 });
        return Response.json(
          {
            backend: "first",
            path: url.pathname,
            search: url.search,
            workspace: request.headers.get("x-opencode-workspace"),
            body: request.method === "GET" ? undefined : await request.text(),
          },
          { status: 202, headers: { "x-upstream": "first" } },
        );
      },
    });
    using second = Bun.serve({
      port: 0,
      fetch: (request) => {
        secondRequests.count++;
        const url = new URL(request.url);
        if (url.pathname === "/api/session" && request.method === "GET")
          return Response.json({
            data: [sessionInfo("ses_second")],
            cursor: {},
          });
        if (url.pathname === "/api/session/active")
          return Response.json({ data: { ses_second: { type: "running" } } });
        return Response.json({
          backend: "second",
          path: new URL(request.url).pathname,
        });
      },
    });
    const runtime = ManagedRuntime.make(
      services(await databasePath(), first.url.toString()),
    );

    try {
      const workspaces = await runtime.runPromise(
        Effect.gen(function* () {
          const registry = yield* GatewayRegistry.Service;
          const firstWorkspace = yield* registry.createWorkspace({
            directory: "/persist/project",
          });
          const secondWorkspace = yield* registry.createWorkspace({
            directory: "/persist/project",
          });
          yield* registry.registerSandbox({
            id: "sb_first",
            workspaceID: firstWorkspace.id,
            generation: 1,
            status: "running",
            endpoint: first.url.toString(),
            timeCreated: 1,
          });
          yield* registry.registerSandbox({
            id: "sb_second",
            workspaceID: secondWorkspace.id,
            generation: 1,
            status: "running",
            endpoint: second.url.toString(),
            timeCreated: 1,
          });
          yield* registry.registerSession({
            id: "ses_first",
            workspaceID: firstWorkspace.id,
            projectID: "same-project",
            timeCreated: 1,
            timeUpdated: 1,
          });
          yield* registry.registerSession({
            id: "ses_second",
            workspaceID: secondWorkspace.id,
            projectID: "same-project",
            timeCreated: 1,
            timeUpdated: 1,
          });
          return { first: firstWorkspace, second: secondWorkspace };
        }),
      );
      const handle = (request: Request) =>
        runtime.runPromise(
          GatewayHandler.handle(request, { password, version: "test" }),
        );

      const firstResponse = await handle(
        authenticated("http://gateway.test/api/session/ses_first/prompt", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      );
      expect(firstResponse.status).toBe(202);
      expect(firstResponse.headers.get("x-upstream")).toBe("first");
      expect(await firstResponse.json()).toEqual({
        backend: "first",
        path: "/api/session/ses_first/prompt",
        search: "",
        workspace: null,
        body: JSON.stringify({ text: "hello" }),
      });

      const secondResponse = await handle(
        authenticated("http://gateway.test/api/session/ses_second/message"),
      );
      expect(await secondResponse.json()).toEqual({
        backend: "second",
        path: "/api/session/ses_second/message",
      });

      const location = new URL("http://gateway.test/api/model");
      location.searchParams.set("location[directory]", "/persist/project");
      location.searchParams.set("location[workspace]", workspaces.first.id);
      const locationResponse = await handle(
        authenticated(location.toString(), {
          headers: { "x-opencode-workspace": workspaces.first.id },
        }),
      );
      expect(await locationResponse.json()).toEqual({
        location: {
          directory: "/persist/project",
          workspaceID: workspaces.first.id,
          project: {
            id: "same-project",
            directory: "/persist/project",
            canonical: "/persist/project",
          },
        },
        data: [],
      });

      const commandResponse = await handle(
        authenticated("http://gateway.test/api/command"),
      );
      expect(commandResponse.status).toBe(202);
      expect((await commandResponse.json()).path).toBe("/api/command");

      const sessionResponse = await handle(
        authenticated("http://gateway.test/api/session/ses_first"),
      );
      expect(await sessionResponse.json()).toEqual({
        data: {
          id: "ses_first",
          projectID: "same-project",
          location: {
            directory: "/persist/project",
            workspaceID: workspaces.first.id,
          },
        },
      });

      const shells = new URL("http://gateway.test/api/shell");
      shells.searchParams.set("location[workspace]", workspaces.first.id);
      expect((await handle(authenticated(shells.toString()))).status).toBe(200);
      const shellOutput = await handle(
        authenticated("http://gateway.test/api/shell/sh_first/output"),
      );
      expect(shellOutput.status).toBe(202);
      expect((await shellOutput.json()).backend).toBe("first");
      expect(
        (
          await handle(
            authenticated("http://gateway.test/api/shell/sh_first", {
              method: "DELETE",
            }),
          )
        ).status,
      ).toBe(202);
      expect(
        (
          await handle(
            authenticated("http://gateway.test/api/shell/sh_first/output"),
          )
        ).status,
      ).toBe(404);

      const file = new URL("http://gateway.test/api/fs/read/checkpoint.txt");
      file.searchParams.set("location[workspace]", workspaces.first.id);
      expect(
        new Uint8Array(
          await (await handle(authenticated(file.toString()))).arrayBuffer(),
        ),
      ).toEqual(new Uint8Array([1, 2, 3]));
      const mcp = new URL("http://gateway.test/api/mcp/server/connect");
      mcp.searchParams.set("location[workspace]", workspaces.first.id);
      expect(
        (await handle(authenticated(mcp.toString(), { method: "POST" })))
          .status,
      ).toBe(204);

      const sessions = await handle(
        authenticated(
          "http://gateway.test/api/session?parentID=null&order=desc",
        ),
      );
      const sessionBody = record(await sessions.json());
      if (!Array.isArray(sessionBody.data))
        throw new Error("Expected aggregate session data");
      expect(sessionBody.data.map((session) => record(session).id)).toEqual([
        "ses_first",
        "ses_second",
      ]);
      expect(
        sessionBody.data.map(
          (session) => record(record(session).location).workspaceID,
        ),
      ).toEqual([workspaces.first.id, workspaces.second.id]);
      const titles = sessionBody.data.map((session) =>
        String(record(session).title),
      );
      expect(titles[0]?.endsWith(" New session")).toBe(true);
      expect(titles[1]?.endsWith(" New session")).toBe(true);
      expect(titles[0]?.split(" ")[0]).not.toBe(titles[1]?.split(" ")[0]);
      const active = await handle(
        authenticated("http://gateway.test/api/session/active"),
      );
      expect(await active.json()).toEqual({
        data: {
          ses_first: { type: "running" },
          ses_second: { type: "running" },
        },
      });

      expect(firstRequests.count).toBe(10);
      expect(secondRequests.count).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  test("rejects unauthorized, unknown, aggregate, and project-only requests without an upstream", async () => {
    const requests = { count: 0 };
    using upstream = Bun.serve({
      port: 0,
      fetch: () => {
        requests.count++;
        return new Response("unexpected");
      },
    });
    const runtime = ManagedRuntime.make(services(await databasePath()));

    try {
      const handle = (request: Request) =>
        runtime.runPromise(
          GatewayHandler.handle(request, { password, version: "test" }),
        );

      expect(
        (await handle(new Request("http://gateway.test/api/health"))).status,
      ).toBe(401);
      expect(
        (
          await handle(
            authenticated("http://gateway.test/api/session/ses_unknown"),
          )
        ).status,
      ).toBe(404);
      const sessions = await handle(
        authenticated("http://gateway.test/api/session"),
      );
      expect(sessions.status).toBe(200);
      expect(await sessions.json()).toEqual({ data: [], cursor: {} });
      expect(
        (
          await handle(
            authenticated("http://gateway.test/api/worktree/same-project"),
          )
        ).status,
      ).toBe(501);
      expect(
        (
          await handle(
            authenticated("http://gateway.test/api/permission/saved/perm_1"),
          )
        ).status,
      ).toBe(501);

      const projects = await handle(
        authenticated("http://gateway.test/api/project"),
      );
      expect(projects.status).toBe(200);
      expect(await projects.json()).toEqual([]);

      const saved = await handle(
        authenticated("http://gateway.test/api/permission/saved"),
      );
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ data: [] });

      const server = await handle(
        authenticated("http://gateway.test/api/server"),
      );
      expect(await server.json()).toEqual({
        urls: ["http://gateway.test"],
        gateway: { images: [{ name: "default" }] },
      });

      const location = await handle(
        authenticated("http://gateway.test/api/location"),
      );
      expect(location.status).toBe(200);
      expect(await location.json()).toEqual({
        directory: "/root",
        project: {
          id: "global",
          directory: "/root",
          canonical: "/root",
        },
      });
      const externalLocation = new URL("http://gateway.test/api/location");
      externalLocation.searchParams.set(
        "location[directory]",
        "/home/client/projects/opencode-gateway",
      );
      expect(
        await (await handle(authenticated(externalLocation.toString()))).json(),
      ).toEqual({
        directory: "/root",
        project: {
          id: "global",
          directory: "/root",
          canonical: "/root",
        },
      });
      const unknownImage = new URL("http://gateway.test/api/location");
      unknownImage.searchParams.set("location[directory]", "/root/missing");
      expect(
        await (await handle(authenticated(unknownImage.toString()))).json(),
      ).toEqual({
        directory: "/root",
        project: {
          id: "global",
          directory: "/root",
          canonical: "/root",
        },
      });
      const images = await handle(
        authenticated("http://gateway.test/api/gateway/image"),
      );
      expect(images.status).toBe(200);
      expect(await images.json()).toEqual({
        data: [{ name: "default" }],
      });
      const missingImage = await handle(
        authenticated("http://gateway.test/api/gateway/image/missing"),
      );
      expect(missingImage.status).toBe(404);
      expect(requests.count).toBe(0);
      void upstream;
    } finally {
      await runtime.dispose();
    }
  });

  test("carries an image workspace selector into normal provisioning", async () => {
    let input: GatewayProvision.Input | undefined;
    const session = Schema.decodeUnknownSync(Session.Info)(
      sessionInfo("ses_image"),
    );
    const runtime = ManagedRuntime.make(
      services(
        await databasePath(),
        "http://127.0.0.1:1",
        GatewayProvision.Service.of({
          create: (value) => {
            input = value;
            return Effect.succeed(session);
          },
          resume: () => Effect.die(new Error("not used")),
          terminate: () => Effect.die(new Error("not used")),
        }),
      ),
    );

    try {
      const handle = (request: Request) =>
        runtime.runPromise(
          GatewayHandler.handle(request, { password, version: "test" }),
        );
      const selected = await handle(
        authenticated("http://gateway.test/api/gateway/image/default"),
      );
      expect(selected.status).toBe(200);
      expect(await selected.json()).toEqual({
        directory: "/root",
        workspaceID: "wrk_image_default",
        project: {
          id: "global",
          directory: "/root",
          canonical: "/root",
        },
      });

      const location = new URL("http://gateway.test/api/location");
      location.searchParams.set("location[directory]", "/root");
      location.searchParams.set("location[workspace]", "wrk_image_default");
      expect(
        await (await handle(authenticated(location.toString()))).json(),
      ).toEqual({
        directory: "/root",
        workspaceID: "wrk_image_default",
        project: {
          id: "global",
          directory: "/root",
          canonical: "/root",
        },
      });
      for (const endpoint of [
        "/api/shell",
        "/api/session/global/form/request",
      ]) {
        const url = new URL(`http://gateway.test${endpoint}`);
        url.searchParams.set("location[directory]", "/root");
        url.searchParams.set("location[workspace]", "wrk_image_default");
        expect(
          await (await handle(authenticated(url.toString()))).json(),
        ).toEqual({
          location: {
            directory: "/root",
            workspaceID: "wrk_image_default",
            project: {
              id: "global",
              directory: "/root",
              canonical: "/root",
            },
          },
          data: [],
        });
      }

      const response = await handle(
        authenticated("http://gateway.test/api/session", {
          method: "POST",
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "anthropic", id: "claude" },
            location: {
              directory: "/root",
              workspaceID: "wrk_image_default",
            },
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: sessionInfo("ses_image") });
      expect(input?.location?.directory).toBe(AbsolutePath.make("/root"));
      expect(input?.location?.workspaceID).toBe(
        Workspace.ID.make("wrk_image_default"),
      );
      expect(String(input?.agent)).toBe("build");
      expect(String(input?.model?.providerID)).toBe("anthropic");
      expect(String(input?.model?.id)).toBe("claude");

      const missing = await handle(
        authenticated("http://gateway.test/api/gateway/image/missing"),
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        code: "image_not_found",
        name: "missing",
      });
    } finally {
      await runtime.dispose();
    }
  });

  test("serves the authenticated gateway over a foreground listener", async () => {
    const layers = services(await databasePath());

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* GatewayProcess.serve(
            {
              hostname: "127.0.0.1",
              port: 0,
              password,
              version: "test-version",
            },
            layers,
          );
          const denied = yield* Effect.promise(() =>
            fetch(new URL("/api/health", gateway.url)),
          );
          expect(denied.status).toBe(401);
          const response = yield* Effect.promise(() =>
            fetch(new URL("/api/health", gateway.url), {
              headers: {
                authorization: `Basic ${btoa(`opencode:${password}`)}`,
              },
            }),
          );
          expect(response.status).toBe(200);
          const body = yield* Effect.promise(() => response.json());
          expect(body).toEqual({
            healthy: true,
            version: "test-version",
            pid: process.pid,
          });
        }),
      ),
    );
  });

  test("registers session creation before publishing the translated event", async () => {
    const runtime = ManagedRuntime.make(services(await databasePath()));
    try {
      const workspace = await runtime.runPromise(
        Effect.gen(function* () {
          const registry = yield* GatewayRegistry.Service;
          return yield* registry.createWorkspace({
            directory: "/persist/project",
          });
        }),
      );
      const response = await runtime.runPromise(
        GatewayHandler.handle(authenticated("http://gateway.test/api/event"), {
          password,
          version: "test",
        }),
      );
      if (!response.body) throw new Error("Expected event stream");
      const reader = response.body.getReader();
      expect(record(await readEvent(reader)).type).toBe("server.connected");

      const sessionID = Session.ID.make("ses_created");
      const projectID = Project.ID.make("same-project");
      const directory = AbsolutePath.make("/persist/project");
      const event: Extract<
        OpenCodeEvent,
        { readonly type: "session.created" }
      > = {
        id: Event.ID.create(),
        type: "session.created",
        created: DateTime.nowUnsafe(),
        durable: {
          aggregateID: sessionID,
          seq: Event.Seq.make(1),
          version: Event.Version.make(1),
        },
        location: { directory },
        data: {
          sessionID,
          projectID,
          location: { directory },
          slug: "created-session",
          version: "test",
        },
      };
      await runtime.runPromise(
        GatewayEvents.Service.use((events) =>
          events.publish(event, workspace.id),
        ),
      );
      const registered = await runtime.runPromise(
        GatewayRegistry.Service.use((registry) =>
          registry.findSession(sessionID),
        ),
      );
      expect(registered?.workspaceID).toBe(workspace.id);
      const published = record(await readEvent(reader));
      expect(record(record(published.data).location).workspaceID).toBe(
        workspace.id,
      );
      expect(record(published.location).workspaceID).toBe(workspace.id);
      await reader.cancel();
    } finally {
      await runtime.dispose();
    }
  });
});

function sessionInfo(id: string) {
  return {
    id,
    projectID: "same-project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: "/persist/project" },
  };
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  if (result.done) throw new Error("Event stream closed");
  const line = new TextDecoder().decode(result.value).trim();
  const value: unknown = JSON.parse(line.replace(/^data:\s*/, ""));
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
