import { existsSync, readFileSync } from "node:fs";

import { createApp } from "./app.js";
import { parseConfig } from "./domain/config.js";
import { Orchestrator, systemClock } from "./domain/orchestrator.js";
import { FileJournal } from "./store/journal.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const runtimeDir = process.env.RUNTIME_DIR ?? ".runtime";
const pollMs = Number.parseInt(process.env.POLL_MS ?? "5000", 10);
const seedConfigPath = process.env.SEED_CONFIG ?? "reference/sample-config.json";

// 进程恢复：重放事件日志，原计划的绝对计时与补偿链继续生效。
const journal = new FileJournal(runtimeDir);
const events = journal.loadAll();
const orchestrator = Orchestrator.replay(events, { clock: systemClock, journal });

// 首次启动（无历史配置）时加载示例配置，便于直接体验完整流程。
if (!events.some((event) => event.type === "config_loaded") && existsSync(seedConfigPath)) {
  const raw = JSON.parse(readFileSync(seedConfigPath, "utf8")) as unknown;
  orchestrator.loadConfig(parseConfig(raw));
  process.stdout.write(`loaded seed config from ${seedConfigPath}\n`);
}

orchestrator.evaluate();
const timer = setInterval(() => orchestrator.evaluate(), pollMs);
timer.unref();

const server = createApp({ orchestrator });
server.listen(port, host, () => {
  process.stdout.write(`service listening on ${host}:${port}\n`);
});

const shutdown = (): void => {
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
