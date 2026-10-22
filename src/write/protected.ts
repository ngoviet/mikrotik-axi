import type { DeviceProfile } from "../config/profile.js";
import { fail } from "../errors.js";
import type { RosRecord } from "../ros/normalize.js";

/** "80", "80,443", "8000-8100", "!22" có chứa cổng `port` không (thận trọng: tính cả "!"). */
export function portSpecIncludes(spec: string | undefined, port: number): boolean {
  if (!spec) return false;
  return spec.split(",").some((part) => {
    const [a, b] = part.replace(/^!/, "").split("-").map(Number);
    if (a === undefined || Number.isNaN(a)) return false;
    return b === undefined || Number.isNaN(b) ? a === port : a <= port && port <= b;
  });
}

/**
 * §6 bước 2: từ chối chạm vào NAT có dst-port được bảo vệ (ví dụ 80/443 của reverse proxy) hoặc
 * object có comment mang tiền tố được bảo vệ. Chạy cho CẢ dry-run để agent biết sớm.
 */
export function assertNotProtected(device: DeviceProfile, menu: string, record: RosRecord | null): void {
  if (!record) return;
  const p = device.protected;
  if (!p) return;
  const comment = record["comment"] ?? "";
  const prefix = p.comment_prefixes?.find((x) => comment.startsWith(x));
  if (prefix) {
    fail(`refusing to modify ${menu} ${record[".id"] ?? ""}: comment "${comment}" has protected prefix ${prefix}`, "WRITE_REFUSED", [
      "Protected objects are listed in the profile (protected.comment_prefixes); change them by hand on the router",
    ]);
  }
  if (menu.endsWith("/firewall/nat")) {
    const port = p.nat_dst_ports?.find((x) => portSpecIncludes(record["dst-port"], x));
    if (port !== undefined) {
      fail(`refusing to modify NAT ${record[".id"] ?? ""}: dst-port ${record["dst-port"]} includes protected port ${port}`, "WRITE_REFUSED", [
        "Protected NAT ports are listed in the profile (protected.nat_dst_ports)",
      ]);
    }
  }
}
