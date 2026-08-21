#!/usr/bin/env bun

import { NodeRuntime } from "@effect/platform-node";
import { Service } from "@opencode-ai/client/service";
import { Effect } from "effect";
import os from "os";
import path from "path";
import { parseArgs } from "util";
import { GatewayProcess } from "./process.js";

const args = parseArgs({
  options: {
    hostname: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "4097" },
    database: { type: "string" },
    app: { type: "string", default: "opencode-gateway-dev" },
    volume: { type: "string", default: "opencode-gateway-workspaces-dev" },
    environment: { type: "string" },
    root: { type: "string", default: "/root" },
    image: { type: "string", default: "oven/bun:1.3.14" },
    "opencode-version": { type: "string", default: "dev" },
  },
});

const password = process.env.OPENCODE_GATEWAY_PASSWORD;
if (!password) throw new Error("OPENCODE_GATEWAY_PASSWORD is required");
const data = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
  "opencode",
);
const requestedCredentialDatabase = process.env.OPENCODE_DB ?? "opencode.db";

const program = Effect.gen(function* () {
  const control = yield* Effect.tryPromise(() => Service.discover());
  if (!control)
    return yield* Effect.fail(
      new Error(
        "Local OpenCode service is not running; run `opencode2 service start`",
      ),
    );
  const gateway = yield* GatewayProcess.start({
    hostname: args.values.hostname,
    port: Number(args.values.port),
    password,
    upstreamPassword:
      process.env.OPENCODE_GATEWAY_UPSTREAM_PASSWORD ?? password,
    version: "0.1.0",
    database:
      args.values.database ??
      path.join(path.dirname(data), "opencode-gateway", "gateway.db"),
    credentialDatabase: path.isAbsolute(requestedCredentialDatabase)
      ? requestedCredentialDatabase
      : path.join(data, requestedCredentialDatabase),
    controlPlane: { url: control.url, headers: Service.headers(control) ?? {} },
    root: args.values.root,
    modal: {
      app: args.values.app,
      volume: args.values.volume,
      environment: args.values.environment,
      image: args.values.image,
      opencodeVersion: args.values["opencode-version"],
    },
  });
  yield* Effect.logInfo("OpenCode gateway listening", {
    url: gateway.url.toString(),
  });
  return yield* Effect.never;
});

NodeRuntime.runMain(Effect.scoped(program));
