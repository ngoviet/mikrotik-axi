import { toBool, type RosRecord } from "../ros/normalize.js";

/**
 * Dịch vụ bật mà `available-from` rỗng ⇒ mở mọi nguồn. Ngoại lệ: `reverse-proxy` khi chắc chắn 0
 * rule ⇒ "idle" (chưa nghe). `proxyRules` undefined (không đọc được) ⇒ thận trọng, tính là mở.
 */
export function classifyOpen(services: RosRecord[], proxyRules: number | undefined): { open: string[]; idle: string[] } {
  const open: string[] = [];
  const idle: string[] = [];
  for (const s of services) {
    if (toBool(s["disabled"], "disabled") || s["available-from"]) continue;
    const name = s["name"] ?? "?";
    if (name === "reverse-proxy" && proxyRules === 0) idle.push(name);
    else open.push(name);
  }
  return { open, idle };
}
