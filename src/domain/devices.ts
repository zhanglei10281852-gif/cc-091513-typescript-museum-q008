import type { DeviceConfig, LoadClass } from "./types.js";
import { ValidationError } from "./time.js";

/** 生命安全与藏品保护负荷永远不得被削减。 */
export function isProtected(loadClass: LoadClass): boolean {
  return loadClass === "life_safety" || loadClass === "collection_protection";
}

/** 可参与排程（启停/降载）的负荷：非连续运行且非保护类。 */
export function isSchedulable(device: DeviceConfig): boolean {
  return !device.continuous && !isProtected(device.loadClass);
}

/** 削峰时允许被重排的非关键负荷。 */
export function isCurtailable(device: DeviceConfig): boolean {
  return isSchedulable(device) && device.loadClass === "deferrable";
}

/**
 * 查询功率曲线：取不大于 offset 的最后一个采样点；
 * 早于首个采样点取首点，晚于末点取末点，空曲线按额定功率。
 */
export function curveKwAt(device: DeviceConfig, offsetMinutes: number): number {
  const curve = device.curve;
  if (curve.length === 0) {
    return device.ratedPowerKw;
  }
  let kw = curve[0]!.kw;
  for (const point of curve) {
    if (point.offsetMinutes <= offsetMinutes) {
      kw = point.kw;
    } else {
      break;
    }
  }
  return kw;
}

/**
 * 依赖拓扑排序（requires 指向的设备排在前面）。
 * 返回启动顺序；停机顺序为其逆序（先停依赖方，再停被依赖方）。
 */
export function dependencyOrder(devices: DeviceConfig[]): DeviceConfig[] {
  const byId = new Map(devices.map((device) => [device.id, device]));
  for (const device of devices) {
    for (const required of device.requires) {
      if (!byId.has(required)) {
        throw new ValidationError(`设备 ${device.id} 依赖未知设备 ${required}`, "unknown_dependency");
      }
      if (required === device.id) {
        throw new ValidationError(`设备 ${device.id} 不能依赖自身`, "dependency_cycle");
      }
    }
  }

  const ordered: DeviceConfig[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (device: DeviceConfig): void => {
    const mark = state.get(device.id);
    if (mark === "done") {
      return;
    }
    if (mark === "visiting") {
      throw new ValidationError(`设备 ${device.id} 的启停依赖存在环`, "dependency_cycle");
    }
    state.set(device.id, "visiting");
    for (const required of device.requires) {
      visit(byId.get(required)!);
    }
    state.set(device.id, "done");
    ordered.push(device);
  };
  for (const device of devices) {
    visit(device);
  }
  return ordered;
}
