export * as GatewayClient from "./client.js";

import { OpenCode } from "@opencode-ai/client/effect";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Connection } from "./backend.js";

export function make(
  connection: Connection,
  httpClient: HttpClient.HttpClient,
) {
  const url = new URL(connection.url);
  const query = [...url.searchParams];
  url.search = "";
  const configured = HttpClient.mapRequest(httpClient, (request) =>
    HttpClientRequest.setUrlParams(
      HttpClientRequest.setHeaders(request, connection.headers),
      query,
    ),
  );
  return OpenCode.make({ baseUrl: url }).pipe(
    Effect.provideService(HttpClient.HttpClient, configured),
  );
}
