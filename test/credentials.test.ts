import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { GatewayCredentials } from "../src/credentials";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("snapshots complete key and OAuth credentials", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencode-gateway-credentials-"),
  );
  directories.push(directory);
  const file = path.join(directory, "opencode.db");
  const database = new Database(file);
  database.run(`
    CREATE TABLE credential (
      id TEXT PRIMARY KEY,
      integration_id TEXT,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      connector_id TEXT,
      method_id TEXT,
      active INTEGER,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `);
  database
    .query("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, 1)")
    .run(
      "cred_oauth",
      "provider",
      "OAuth",
      JSON.stringify({
        type: "oauth",
        methodID: "oauth",
        access: "access",
        refresh: "refresh",
        expires: 1,
      }),
    );
  database
    .query("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, 1)")
    .run(
      "cred_key",
      "other",
      "Key",
      JSON.stringify({ type: "key", key: "secret" }),
    );
  database.close();

  const runtime = ManagedRuntime.make(GatewayCredentials.layer(file));
  try {
    const snapshot = await runtime.runPromise(
      GatewayCredentials.Service.use((credentials) =>
        Effect.succeed(credentials.snapshot),
      ),
    );
    expect(snapshot).toHaveLength(2);
    const oauth = snapshot.find((row) => row.id === "cred_oauth");
    const key = snapshot.find((row) => row.id === "cred_key");
    expect(oauth).toBeDefined();
    expect(key).toBeDefined();
    const oauthValue: unknown = JSON.parse(oauth?.value ?? "");
    const keyValue: unknown = JSON.parse(key?.value ?? "");
    expect(oauthValue).toEqual({
      type: "oauth",
      methodID: "oauth",
      access: "access",
      refresh: "refresh",
      expires: 1,
    });
    expect(keyValue).toEqual({ type: "key", key: "secret" });
  } finally {
    await runtime.dispose();
  }
});
