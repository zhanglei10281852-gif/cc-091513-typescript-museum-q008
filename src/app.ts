import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  parseConfig,
  parseLimit,
  parseOverride,
  parseReceipt,
  parseTelemetryBatch,
} from "./domain/config.js";
import { Orchestrator, systemClock } from "./domain/orchestrator.js";
import { parseTimestamp, ValidationError } from "./domain/time.js";

export const serviceName = "展项能源负荷编排服务";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

export interface AppDeps {
  orchestrator?: Orchestrator;
}

const MAX_BODY_BYTES = 1_000_000;

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new ValidationError("请求体超过 1MB 限制", "payload_too_large");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("请求体不是合法 JSON", "invalid_json");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function errorStatus(error: ValidationError): number {
  if (error.code === "protected_device") {
    return 409;
  }
  if (error.code === "unknown_command" || error.code === "unknown_override") {
    return 404;
  }
  return 400;
}

export function createApp(deps: AppDeps = {}): Server {
  const orchestrator = deps.orchestrator ?? new Orchestrator({ clock: systemClock });

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = request.method ?? "GET";

      if (method === "GET" && path === "/health") {
        sendJson(response, 200, healthPayload());
        return;
      }

      if (method === "GET" && path === "/v1/status") {
        sendJson(response, 200, orchestrator.status());
        return;
      }

      if (method === "GET" && path === "/v1/config") {
        sendJson(response, 200, orchestrator.configView());
        return;
      }

      if (method === "POST" && path === "/v1/config") {
        const config = parseConfig(await readJsonBody(request));
        orchestrator.loadConfig(config);
        sendJson(response, 201, {
          halls: config.halls.length,
          devices: config.devices.length,
          planVersion: orchestrator.state.planVersion,
        });
        return;
      }

      if (method === "GET" && path === "/v1/plan") {
        sendJson(response, 200, orchestrator.planView() ?? { version: 0, entries: [] });
        return;
      }

      if (method === "POST" && path === "/v1/plan/recompute") {
        orchestrator.recompute();
        sendJson(response, 200, { planVersion: orchestrator.state.planVersion });
        return;
      }

      if (method === "GET" && path === "/v1/commands") {
        sendJson(response, 200, orchestrator.commandsView());
        return;
      }

      if (method === "GET" && path === "/v1/decisions") {
        sendJson(response, 200, orchestrator.decisionsView());
        return;
      }

      if (method === "GET" && path === "/v1/limits") {
        sendJson(response, 200, orchestrator.configView().limits);
        return;
      }

      if (method === "POST" && path === "/v1/limits") {
        const limit = parseLimit(await readJsonBody(request), orchestrator.state.seq + 1);
        orchestrator.setLimit(limit);
        sendJson(response, 201, limit);
        return;
      }

      if (method === "POST" && path === "/v1/telemetry") {
        const readings = parseTelemetryBatch(await readJsonBody(request));
        const results = orchestrator.ingestTelemetry(readings);
        sendJson(response, 201, { results });
        return;
      }

      if (method === "POST" && path === "/v1/receipts") {
        const input = parseReceipt(await readJsonBody(request));
        const result = orchestrator.recordReceipt(input);
        sendJson(response, result.deduplicated ? 200 : 201, result);
        return;
      }

      if (method === "POST" && path === "/v1/overrides") {
        const input = parseOverride(await readJsonBody(request), Date.now());
        const override = orchestrator.setOverride(input);
        sendJson(response, 201, override);
        return;
      }

      const releaseMatch = /^\/v1\/overrides\/([^/]+)\/release$/.exec(path);
      if (method === "POST" && releaseMatch) {
        orchestrator.releaseOverride(decodeURIComponent(releaseMatch[1]!));
        sendJson(response, 200, { released: releaseMatch[1] });
        return;
      }

      if (method === "GET" && path === "/v1/metering") {
        const now = Date.now();
        const from = url.searchParams.has("from") ? parseTimestamp(url.searchParams.get("from"), "from") : now - 3_600_000;
        const to = url.searchParams.has("to") ? parseTimestamp(url.searchParams.get("to"), "to") : now;
        sendJson(response, 200, orchestrator.meteringView(from, to));
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ValidationError) {
        sendJson(response, errorStatus(error), { error: error.code, message: error.message });
        return;
      }
      sendJson(response, 500, { error: "internal_error" });
    }
  });
}
