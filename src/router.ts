export * as GatewayRouter from "./router.js";

import { GatewayImage } from "./image.js";

export type Decision =
  | { readonly type: "health" }
  | { readonly type: "server" }
  | { readonly type: "empty-projects" }
  | { readonly type: "empty-saved-permissions" }
  | { readonly type: "default-location" }
  | {
      readonly type: "image-location";
      readonly name: string;
      readonly kind: "info" | "list" | "vcs";
    }
  | { readonly type: "images" }
  | { readonly type: "image"; readonly name: string }
  | { readonly type: "sessions" }
  | { readonly type: "active-sessions" }
  | { readonly type: "events" }
  | { readonly type: "provision-session" }
  | { readonly type: "control" }
  | { readonly type: "session"; readonly sessionID: string }
  | { readonly type: "workspace"; readonly workspaceID: string }
  | {
      readonly type: "resource";
      readonly kind: "pty" | "shell";
      readonly id: string;
    }
  | { readonly type: "unsupported"; readonly reason: string };

export function classify(request: Request): Decision {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const workspaceID = workspace(request, url);
  const imageName = GatewayImage.fromWorkspace(workspaceID);

  if (method === "GET" && url.pathname === "/api/health")
    return { type: "health" };
  if (method === "GET" && url.pathname === "/api/server")
    return { type: "server" };
  if (method === "GET" && url.pathname === "/api/project")
    return { type: "empty-projects" };
  if (method === "GET" && url.pathname === "/api/permission/saved")
    return { type: "empty-saved-permissions" };
  if (control(url.pathname)) return { type: "control" };
  if (url.pathname.startsWith("/api/worktree/"))
    return {
      type: "unsupported",
      reason: "worktree routes are not supported by the gateway",
    };
  if (url.pathname.startsWith("/api/permission/saved"))
    return {
      type: "unsupported",
      reason: "saved permission mutations are not supported by the gateway",
    };

  const experimentalSession = url.pathname.match(
    /^\/api\/experimental\/session\/([^/]+)\/log$/,
  );
  if (experimentalSession)
    return { type: "session", sessionID: experimentalSession[1] };

  if (url.pathname === "/api/session") {
    if (method === "GET") {
      const parentID = url.searchParams.get("parentID");
      if (parentID && parentID !== "null")
        return { type: "session", sessionID: parentID };
      return { type: "sessions" };
    }
    if (method === "POST") return { type: "provision-session" };
  }
  if (url.pathname === "/api/session/import")
    return {
      type: "unsupported",
      reason: "session import is not implemented yet",
    };
  if (url.pathname === "/api/session/active")
    return { type: "active-sessions" };
  if (/^\/api\/session\/[^/]+\/move$/.test(url.pathname))
    return {
      type: "unsupported",
      reason: "session movement is not supported by the gateway",
    };
  if (/^\/api\/pty\/[^/]+\/connect$/.test(url.pathname))
    return {
      type: "unsupported",
      reason: "PTY WebSocket proxying is not supported by the gateway",
    };

  if (/^\/api\/session\/global\/form(?:\/|$)/.test(url.pathname)) {
    if (method === "GET" && imageName)
      return { type: "image-location", name: imageName, kind: "list" };
    return workspaceID
      ? { type: "workspace", workspaceID }
      : {
          type: "unsupported",
          reason: "global forms require an explicit workspace",
        };
  }

  const session = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/|$)/);
  if (session) return { type: "session", sessionID: session[1] };

  if (method === "GET" && imageName) {
    if (url.pathname === "/api/location")
      return { type: "image-location", name: imageName, kind: "info" };
    if (url.pathname === "/api/vcs")
      return { type: "image-location", name: imageName, kind: "vcs" };
    if (url.pathname === "/api/shell")
      return { type: "image-location", name: imageName, kind: "list" };
    if (imageControl(url.pathname)) return { type: "control" };
  }
  if (workspaceID) return { type: "workspace", workspaceID };
  if (method === "GET" && url.pathname === "/api/gateway/image")
    return { type: "images" };
  const image = url.pathname.match(/^\/api\/gateway\/image\/([^/]+)$/);
  if (method === "GET" && image) {
    const name = decodePath(image[1]);
    return name
      ? { type: "image", name }
      : { type: "unsupported", reason: "invalid gateway image name" };
  }
  if (method === "GET" && url.pathname === "/api/location")
    return { type: "default-location" };

  const resource = url.pathname.match(/^\/api\/(pty|shell)\/([^/]+)(?:\/|$)/);
  if (resource)
    return {
      type: "resource",
      kind: resource[1] === "pty" ? "pty" : "shell",
      id: resource[2],
    };

  if (url.pathname === "/api/event") return { type: "events" };
  return {
    type: "unsupported",
    reason: "request has no session, workspace, or registered resource owner",
  };
}

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return;
  }
}

function control(pathname: string) {
  return [
    "/api/agent",
    "/api/model",
    "/api/provider",
    "/api/integration",
    "/api/credential",
    "/api/plugin",
    "/api/config",
    "/api/command",
    "/api/experimental/integration/wellknown",
    "/api/experimental/migration/v1",
  ].some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
}

function imageControl(pathname: string) {
  return ["/api/mcp", "/api/reference", "/api/skill"].some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

function workspace(request: Request, url: URL) {
  return (
    url.searchParams.get("workspace") ??
    url.searchParams.get("location[workspace]") ??
    url.searchParams.get("location.workspace") ??
    request.headers.get("x-opencode-workspace") ??
    undefined
  );
}
