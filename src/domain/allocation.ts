/**
 * 峰值额度的稳定分配：按批准优先级分层，层内按需求比例分配。
 * 算法对相同输入永远产生相同输出（确定性），层内余数按展厅标识字典序分配，
 * 保证多个展厅争用额度时结果稳定、可复算。
 */

export interface AllocationRequest {
  hallId: string;
  priority: number;
  demandedKw: number;
}

export interface AllocationGrant {
  hallId: string;
  demandedKw: number;
  allocatedKw: number;
}

const EPSILON = 1e-9;

export function allocateStable(requests: AllocationRequest[], capacityKw: number): AllocationGrant[] {
  const sorted = [...requests].sort((a, b) => a.priority - b.priority || a.hallId.localeCompare(b.hallId));
  const granted = new Map<string, number>();
  let remaining = Math.max(0, capacityKw);

  let index = 0;
  while (index < sorted.length) {
    const priority = sorted[index]!.priority;
    const tier: AllocationRequest[] = [];
    while (index < sorted.length && sorted[index]!.priority === priority) {
      tier.push(sorted[index]!);
      index += 1;
    }
    const tierDemand = tier.reduce((sum, request) => sum + Math.max(0, request.demandedKw), 0);
    if (tierDemand <= EPSILON) {
      continue;
    }
    if (remaining + EPSILON >= tierDemand) {
      for (const request of tier) {
        granted.set(request.hallId, Math.max(0, request.demandedKw));
      }
      remaining -= tierDemand;
      continue;
    }
    // 容量不足：层内按需求比例分配，余数按 hallId 顺序逐个补齐，保证确定性。
    const scale = remaining / tierDemand;
    const shares = tier.map((request) => {
      const exact = Math.max(0, request.demandedKw) * scale;
      const floor = Math.floor(exact * 1000) / 1000;
      return { hallId: request.hallId, floor, remainder: exact - floor };
    });
    let leftover = remaining - shares.reduce((sum, share) => sum + share.floor, 0);
    const byRemainder = [...shares].sort(
      (a, b) => b.remainder - a.remainder || a.hallId.localeCompare(b.hallId),
    );
    for (const share of byRemainder) {
      if (leftover <= EPSILON) {
        break;
      }
      const topUp = Math.min(0.001, leftover);
      share.floor += topUp;
      leftover -= topUp;
    }
    for (const share of shares) {
      granted.set(share.hallId, share.floor);
    }
    remaining = 0;
  }

  return sorted.map((request) => ({
    hallId: request.hallId,
    demandedKw: Math.max(0, request.demandedKw),
    allocatedKw: round3(granted.get(request.hallId) ?? 0),
  }));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
