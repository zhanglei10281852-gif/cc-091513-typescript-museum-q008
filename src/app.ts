import { createServer, type Server } from "node:http";

export const serviceName = "展项能源负荷编排服务";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

export function createApp(): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(healthPayload()));
  });
}
