import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Event } from "../domain/events.js";

/**
 * 追加式事件日志：每条事件一行 JSON，写入 .runtime/journal.jsonl。
 * 进程恢复时全量重放，还原计划、命令台账、回执、遥测与接管状态。
 */
export class FileJournal {
  readonly path: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "journal.jsonl");
  }

  append(event: Event): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }

  loadAll(): Event[] {
    if (!existsSync(this.path)) {
      return [];
    }
    const content = readFileSync(this.path, "utf8");
    const events: Event[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      events.push(JSON.parse(trimmed) as Event);
    }
    return events;
  }
}

/** 测试用内存日志。 */
export class MemoryJournal {
  readonly events: Event[] = [];

  append(event: Event): void {
    this.events.push(event);
  }

  loadAll(): Event[] {
    return [...this.events];
  }
}
