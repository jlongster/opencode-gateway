export * as GatewayHandler from "./handler.js";

import { Workspace } from "@opencode-ai/schema/workspace";
import { Session } from "@opencode-ai/schema/session";
import { Effect, Option, Schema } from "effect";
import { GatewayAggregate } from "./aggregate.js";
import { GatewayBackend } from "./backend.js";
import { GatewayControl } from "./control.js";
import { GatewayEvents } from "./events.js";
import { GatewayImage } from "./image.js";
import { GatewayIcon } from "./icon.js";
import { GatewayModal } from "./modal.js";
import { GatewayProvision } from "./provision.js";
import { GatewayRegistry } from "./registry.js";
import { GatewayRouter } from "./router.js";

const decodeWorkspaceID = Schema.decodeUnknownOption(Workspace.ID);
const encodeSessions = Schema.encodeSync(Schema.Array(Session.Info));
const encodeSession = Schema.encodeSync(Session.Info);
const decodeSession = Schema.decodeUnknownSync(Session.Info);
const decodeSessionOption = Schema.decodeUnknownOption(Session.Info);
const decodeProvision = Schema.decodeUnknownOption(GatewayProvision.Input);
const hopByHop = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export interface Options {
  readonly password: string;
  readonly version: string;
  readonly root?: string;
}

export function handle(request: Request, options: Options) {
  return Effect.gen(function* () {
    if (!authorized(request, options.password)) return unauthorized();
    const decision = GatewayRouter.classify(request);
    if (decision.type === "health")
      return Response.json({
        healthy: true,
        version: options.version,
        pid: process.pid,
      });
    if (decision.type === "server") {
      const registry = yield* GatewayRegistry.Service;
      const images = yield* registry.listImages;
      return Response.json({
        urls: [new URL(request.url).origin],
        gateway: {
          images: images.map((image) => ({
            name: image.name,
            description: image.description,
          })),
        },
      });
    }
    if (decision.type === "empty-projects") return Response.json([]);
    if (decision.type === "empty-saved-permissions")
      return Response.json({ data: [] });
    if (decision.type === "default-location") {
      const root = options.root ?? "/root";
      const url = new URL(request.url);
      const requested =
        url.searchParams.get("location[directory]") ??
        url.searchParams.get("location.directory");
      const requestedName = GatewayImage.candidate(
        requested ?? undefined,
        root,
      );
      const registry = yield* GatewayRegistry.Service;
      const requestedImage = yield* registry.findImage(requestedName);
      const name = requestedImage ? requestedName : GatewayImage.DefaultName;
      const directory = GatewayImage.directory(name, root);
      return Response.json({
        directory,
        project: { id: "global", directory: root, canonical: root },
      });
    }
    if (decision.type === "image-location") {
      const registry = yield* GatewayRegistry.Service;
      if (!(yield* registry.findImage(decision.name)))
        return Response.json(
          { code: "image_not_found", name: decision.name },
          { status: 404 },
        );
      const root = options.root ?? "/root";
      const location = {
        directory: root,
        workspaceID: GatewayImage.workspace(decision.name),
        project: { id: "global", directory: root, canonical: root },
      };
      if (decision.kind === "info") return Response.json(location);
      return Response.json({
        location,
        data: decision.kind === "vcs" ? { branch: {} } : [],
      });
    }
    if (decision.type === "images") {
      const registry = yield* GatewayRegistry.Service;
      const images = yield* registry.listImages;
      return Response.json({
        data: images.map((image) => ({
          name: image.name,
          description: image.description,
        })),
      });
    }
    if (decision.type === "image") {
      const registry = yield* GatewayRegistry.Service;
      if (!(yield* registry.findImage(decision.name)))
        return Response.json(
          { code: "image_not_found", name: decision.name },
          { status: 404 },
        );
      const root = options.root ?? "/root";
      return Response.json({
        directory: root,
        workspaceID: GatewayImage.workspace(decision.name),
        project: { id: "global", directory: root, canonical: root },
      });
    }
    if (decision.type === "sessions") {
      const input = sessionListInput(new URL(request.url));
      if (input instanceof Response) return input;
      const registry = yield* GatewayRegistry.Service;
      const bindings = (yield* registry.listSessions).filter(
        (session) =>
          (!input.workspaceID || session.workspaceID === input.workspaceID) &&
          (input.parentID === undefined ||
            (input.parentID === null
              ? session.parentID === undefined
              : session.parentID === input.parentID)),
      );
      const sessions = yield* Effect.forEach(bindings, (binding) =>
        (binding.info
          ? Effect.succeed(binding.info)
          : registry.getWorkspace(binding.workspaceID).pipe(
              Effect.map((workspace) =>
                decodeSession({
                  id: binding.id,
                  ...(binding.parentID ? { parentID: binding.parentID } : {}),
                  projectID: binding.projectID,
                  cost: 0,
                  tokens: {
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                  time: binding.time,
                  location: {
                    directory: workspace?.directory ?? options.root ?? "/root",
                    workspaceID: binding.workspaceID,
                  },
                }),
              ),
            )
        ).pipe(
          Effect.map((session) => ({
            ...session,
            title: `${GatewayIcon.workspace(binding.workspaceID)} ${session.title ?? "New session"}`,
          })),
        ),
      );
      const search = input.search?.toLowerCase();
      const filtered = search
        ? sessions.filter(
            (session) =>
              session.id.toLowerCase().includes(search) ||
              session.title?.toLowerCase().includes(search),
          )
        : sessions;
      const ordered = input.order === "asc" ? filtered.toReversed() : filtered;
      const selected =
        input.limit === undefined ? ordered : ordered.slice(0, input.limit);
      return Response.json({ data: encodeSessions(selected), cursor: {} });
    }
    if (decision.type === "active-sessions") {
      const aggregate = yield* GatewayAggregate.Service;
      return Response.json({ data: yield* aggregate.active });
    }
    if (decision.type === "events") {
      const events = yield* GatewayEvents.Service;
      return yield* events.subscribe;
    }
    if (decision.type === "provision-session") {
      const body = yield* Effect.tryPromise(() => request.json()).pipe(
        Effect.option,
      );
      if (Option.isNone(body))
        return Response.json({ code: "invalid_request" }, { status: 400 });
      const input = decodeProvision(body.value);
      if (Option.isNone(input))
        return Response.json({ code: "invalid_request" }, { status: 400 });
      const provision = yield* GatewayProvision.Service;
      return yield* provisionResponse(provision.create(input.value));
    }
    if (decision.type === "control") {
      const control = yield* GatewayControl.Service;
      return yield* proxyControl(
        request,
        control.connection,
        options.root ?? "/root",
      );
    }
    if (decision.type === "unsupported") return unsupported(decision.reason);

    const registry = yield* GatewayRegistry.Service;
    const workspaceID = yield* resolveWorkspace(decision, registry);
    if (workspaceID instanceof Response) return workspaceID;
    const backend = yield* GatewayBackend.Service;
    const provision = yield* GatewayProvision.Service;
    return yield* backend.connect(workspaceID).pipe(
      Effect.catchTag("GatewayBackend.UnavailableError", () =>
        provision
          .resume(workspaceID)
          .pipe(Effect.andThen(backend.connect(workspaceID))),
      ),
      Effect.flatMap((connection) =>
        proxy(request, connection, workspaceID, decision, registry, provision),
      ),
      Effect.catchTag("GatewayBackend.UnavailableError", (error) =>
        Effect.succeed(
          Response.json(
            {
              code: "workspace_unavailable",
              workspaceID,
              message: error.reason,
            },
            { status: 503 },
          ),
        ),
      ),
      Effect.catchTag("GatewayProvision.ProvisionError", (error) =>
        Effect.succeed(
          Response.json(
            {
              code: "workspace_restore_failed",
              workspaceID,
              message: causeMessage(error.cause),
            },
            { status: 503 },
          ),
        ),
      ),
    );
  });
}

function resolveWorkspace(
  decision: Exclude<
    GatewayRouter.Decision,
    {
      readonly type:
        | "health"
        | "server"
        | "empty-projects"
        | "empty-saved-permissions"
        | "default-location"
        | "images"
        | "image"
        | "image-location"
        | "sessions"
        | "active-sessions"
        | "events"
        | "provision-session"
        | "control"
        | "unsupported";
    }
  >,
  registry: GatewayRegistry.Interface,
) {
  if (decision.type === "workspace") {
    const decoded = decodeWorkspaceID(decision.workspaceID);
    if (Option.isNone(decoded))
      return Effect.succeed(
        Response.json({ code: "invalid_workspace" }, { status: 400 }),
      );
    return Effect.succeed(decoded.value);
  }
  if (decision.type === "session")
    return registry
      .findSession(decision.sessionID)
      .pipe(
        Effect.map(
          (session) =>
            session?.workspaceID ??
            Response.json(
              { code: "session_not_found", sessionID: decision.sessionID },
              { status: 404 },
            ),
        ),
      );
  return registry.findResource(decision.kind, decision.id).pipe(
    Effect.flatMap((resource) => {
      if (!resource)
        return Effect.succeed(
          Response.json(
            {
              code: "resource_not_found",
              kind: decision.kind,
              id: decision.id,
            },
            { status: 404 },
          ),
        );
      return registry.currentSandbox(resource.workspaceID).pipe(
        Effect.map((sandbox) =>
          sandbox?.id === resource.sandboxID
            ? resource.workspaceID
            : Response.json(
                {
                  code: "resource_expired",
                  kind: decision.kind,
                  id: decision.id,
                },
                { status: 410 },
              ),
        ),
      );
    }),
  );
}

function proxyControl(
  request: Request,
  connection: GatewayBackend.Connection,
  root: string,
) {
  return Effect.tryPromise({
    try: async () => {
      const source = new URL(request.url);
      const target = new URL(source.pathname + source.search, connection.url);
      const workspaceID =
        target.searchParams.get("workspace") ??
        target.searchParams.get("location[workspace]") ??
        target.searchParams.get("location.workspace") ??
        request.headers.get("x-opencode-workspace") ??
        undefined;
      const directory =
        target.searchParams.get("location[directory]") ??
        target.searchParams.get("location.directory") ??
        request.headers.get("x-opencode-directory") ??
        root;
      [
        "workspace",
        "location[workspace]",
        "location.workspace",
        "location[directory]",
        "location.directory",
      ].forEach((name) => target.searchParams.delete(name));
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.delete("host");
      headers.delete("x-opencode-workspace");
      headers.delete("x-opencode-directory");
      hopByHop.forEach((header) => headers.delete(header));
      headers.set("accept-encoding", "identity");
      Object.entries(connection.headers).forEach(([name, value]) =>
        headers.set(name, value),
      );
      const response = await fetch(target, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body,
        redirect: "manual",
        signal: request.signal,
      });
      const responseHeaders = new Headers(response.headers);
      hopByHop.forEach((header) => responseHeaders.delete(header));
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      if (
        !response.ok ||
        response.status === 204 ||
        !response.headers.get("content-type")?.includes("json")
      )
        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        });
      const body: unknown = await response.json();
      const translated = controlLocation(body, directory, workspaceID);
      responseHeaders.delete("content-length");
      responseHeaders.set("content-type", "application/json");
      return new Response(JSON.stringify(translated), {
        status: response.status,
        headers: responseHeaders,
      });
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        Response.json({ code: "control_plane_unavailable" }, { status: 502 }),
      ),
    ),
  );
}

function controlLocation(
  value: unknown,
  directory: string,
  workspaceID: string | undefined,
): unknown {
  if (!record(value) || !location(value.location)) return value;
  return {
    ...value,
    location: {
      ...value.location,
      directory,
      workspaceID,
    },
  };
}

function sessionListInput(
  url: URL,
): GatewayAggregate.SessionListInput | Response {
  const workspace = url.searchParams.get("workspace");
  const workspaceID = workspace ? decodeWorkspaceID(workspace) : Option.none();
  if (workspace && Option.isNone(workspaceID))
    return Response.json({ code: "invalid_workspace" }, { status: 400 });
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    return Response.json({ code: "invalid_limit" }, { status: 400 });
  const orderValue = url.searchParams.get("order");
  const order =
    orderValue === "asc" || orderValue === "desc" ? orderValue : undefined;
  return {
    workspaceID: Option.getOrUndefined(workspaceID),
    limit,
    order,
    search: url.searchParams.get("search") ?? undefined,
    parentID: url.searchParams.get("parentID") === "null" ? null : undefined,
  };
}

function proxy(
  request: Request,
  connection: GatewayBackend.Connection,
  workspaceID: Workspace.ID,
  decision: GatewayRouter.Decision,
  registry: GatewayRegistry.Interface,
  provision: GatewayProvision.Interface,
) {
  return Effect.tryPromise({
    try: async () => {
      const source = new URL(request.url);
      const target = new URL(connection.url);
      const connectionQuery = [...target.searchParams];
      target.pathname = source.pathname;
      target.search = source.search;
      connectionQuery.forEach(([name, value]) =>
        target.searchParams.set(name, value),
      );
      target.searchParams.delete("workspace");
      target.searchParams.delete("location[workspace]");
      target.searchParams.delete("location.workspace");
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.delete("host");
      headers.delete("x-opencode-workspace");
      hopByHop.forEach((header) => headers.delete(header));
      headers.set("accept-encoding", "identity");
      Object.entries(connection.headers).forEach(([name, value]) =>
        headers.set(name, value),
      );
      const response = await fetch(target, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body,
        redirect: "manual",
        signal: request.signal,
      });
      const responseHeaders = new Headers(response.headers);
      hopByHop.forEach((header) => responseHeaders.delete(header));
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((response) =>
      translate(request, response, workspaceID, decision, registry, provision),
    ),
    Effect.catch(() =>
      Effect.succeed(
        Response.json(
          { code: "upstream_unavailable", message: "upstream request failed" },
          { status: 502 },
        ),
      ),
    ),
  );
}

function translate(
  request: Request,
  response: Response,
  workspaceID: Workspace.ID,
  decision: GatewayRouter.Decision,
  registry: GatewayRegistry.Interface,
  provision: GatewayProvision.Interface,
) {
  if (!response.ok) return Effect.succeed(response);
  if (
    request.method === "DELETE" &&
    decision.type === "session" &&
    new URL(request.url).pathname === `/api/session/${decision.sessionID}`
  )
    return provision.terminate(workspaceID).pipe(
      Effect.tapError((error) =>
        Effect.logError("failed to terminate deleted session sandbox", {
          workspaceID,
          sessionID: decision.sessionID,
          error,
        }),
      ),
      Effect.ignore,
      Effect.andThen(registry.removeSession(decision.sessionID)),
      Effect.as(response),
    );
  if (response.status === 204 || !response.body)
    return removeResource(request, response, registry);
  const kind = translation(request, decision);
  if (!kind) return removeResource(request, response, registry);
  if (!response.headers.get("content-type")?.includes("json"))
    return Effect.succeed(response);
  return Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap((body) => {
      const translated =
        kind === "location"
          ? translateLocationResponse(body, workspaceID)
          : translateSessionResponse(body, workspaceID);
      return registerSessionResponses(translated, workspaceID, registry).pipe(
        Effect.andThen(
          registerResources(request, translated, workspaceID, registry),
        ),
        Effect.as(jsonResponse(response, translated)),
      );
    }),
    Effect.catch(() =>
      Effect.succeed(
        Response.json({ code: "invalid_upstream_response" }, { status: 502 }),
      ),
    ),
  );
}

function registerSessionResponses(
  body: unknown,
  workspaceID: Workspace.ID,
  registry: GatewayRegistry.Interface,
) {
  if (!record(body) || !("data" in body)) return Effect.void;
  const values = Array.isArray(body.data)
    ? body.data
    : record(body.data) && record(body.data.info)
      ? [body.data.info]
      : [body.data];
  return Effect.forEach(
    values.filter(sessionValue),
    (session) => {
      const info = Option.getOrUndefined(decodeSessionOption(session));
      return registry.registerSession({
        id: session.id,
        workspaceID,
        projectID: session.projectID,
        parentID:
          typeof session.parentID === "string" ? session.parentID : undefined,
        timeCreated: session.time.created,
        timeUpdated: session.time.updated,
        info,
      });
    },
    { discard: true },
  );
}

function sessionValue(value: unknown): value is {
  readonly id: string;
  readonly projectID: string;
  readonly parentID?: string;
  readonly time: { readonly created: number; readonly updated: number };
} {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.projectID !== "string" ||
    !record(value.time)
  )
    return false;
  return (
    typeof value.time.created === "number" &&
    typeof value.time.updated === "number"
  );
}

function translation(request: Request, decision: GatewayRouter.Decision) {
  if (decision.type === "workspace") return "location" as const;
  if (decision.type !== "session") return undefined;
  const pathname = new URL(request.url).pathname;
  if (request.method === "GET" && pathname === "/api/session")
    return "session" as const;
  if (new RegExp(`^/api/session/${decision.sessionID}$`).test(pathname))
    return "session" as const;
  if (
    new RegExp(`^/api/session/${decision.sessionID}/(fork|export)$`).test(
      pathname,
    )
  )
    return "session" as const;
  return undefined;
}

function translateLocationResponse(
  value: unknown,
  workspaceID: Workspace.ID,
): unknown {
  if (!record(value)) return value;
  if (location(value)) return { ...value, workspaceID };
  if (location(value.location))
    return { ...value, location: { ...value.location, workspaceID } };
  return value;
}

function translateSessionResponse(
  value: unknown,
  workspaceID: Workspace.ID,
): unknown {
  if (!record(value) || !("data" in value)) return value;
  if (Array.isArray(value.data))
    return {
      ...value,
      data: value.data.map((item) =>
        record(item) && location(item.location)
          ? withLocation(item, workspaceID)
          : item,
      ),
    };
  if (!record(value.data)) return value;
  if (location(value.data.location))
    return { ...value, data: withLocation(value.data, workspaceID) };
  if (record(value.data.info) && location(value.data.info.location))
    return {
      ...value,
      data: { ...value.data, info: withLocation(value.data.info, workspaceID) },
    };
  return value;
}

function withLocation<Value extends Record<string, unknown>>(
  value: Value,
  workspaceID: Workspace.ID,
) {
  if (!location(value.location)) return value;
  return { ...value, location: { ...value.location, workspaceID } };
}

function registerResources(
  request: Request,
  body: unknown,
  workspaceID: Workspace.ID,
  registry: GatewayRegistry.Interface,
) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/(pty|shell)$/);
  if (!match || (request.method !== "GET" && request.method !== "POST"))
    return Effect.void;
  if (!record(body) || !record(body.location) || !("data" in body))
    return Effect.void;
  const values = Array.isArray(body.data) ? body.data : [body.data];
  return registry.currentSandbox(workspaceID).pipe(
    Effect.flatMap((sandbox) => {
      if (!sandbox) return Effect.void;
      return Effect.forEach(
        values.filter(
          (value): value is Record<string, unknown> =>
            record(value) && typeof value.id === "string",
        ),
        (value) =>
          registry.registerResource({
            kind: match[1],
            id: String(value.id),
            workspaceID,
            sandboxID: sandbox.id,
          }),
        { discard: true },
      );
    }),
  );
}

function removeResource(
  request: Request,
  response: Response,
  registry: GatewayRegistry.Interface,
) {
  if (request.method !== "DELETE") return Effect.succeed(response);
  const match = new URL(request.url).pathname.match(
    /^\/api\/(pty|shell)\/([^/]+)$/,
  );
  if (!match) return Effect.succeed(response);
  return registry.removeResource(match[1], match[2]).pipe(Effect.as(response));
}

function jsonResponse(response: Response, body: unknown) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function location(
  value: unknown,
): value is Record<string, unknown> & { readonly directory: string } {
  return record(value) && typeof value.directory === "string";
}

function authorized(request: Request, password: string) {
  return (
    request.headers.get("authorization") ===
    `Basic ${btoa(`opencode:${password}`)}`
  );
}

function unauthorized() {
  return new Response(undefined, {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="OpenCode Gateway"' },
  });
}

function unsupported(reason: string) {
  return Response.json(
    { code: "unsupported", message: reason },
    { status: 501 },
  );
}

function provisionResponse(
  effect: Effect.Effect<Session.Info, GatewayProvision.ProvisionError>,
) {
  return effect.pipe(
    Effect.map((session) => Response.json({ data: encodeSession(session) })),
    Effect.catchTag("GatewayProvision.ProvisionError", (error) =>
      Effect.succeed(
        Response.json(
          {
            code: "provision_failed",
            message:
              error.cause instanceof GatewayModal.ModalError
                ? `${error.cause.operation}: ${causeMessage(error.cause.cause)}`
                : causeMessage(error.cause),
          },
          { status: 503 },
        ),
      ),
    ),
  );
}

function causeMessage(cause: unknown) {
  if (cause instanceof Error) return cause.message || cause.name;
  return typeof cause === "string" ? cause : "sandbox provisioning failed";
}
