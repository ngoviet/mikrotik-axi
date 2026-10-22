import { fail } from "../errors.js";

export type RosBody = Record<string, string>;

// Bẫy #3: các trường địa chỉ KHÔNG nhận danh sách phẩy — router trả 400 khó hiểu
// ("value of range must have netmask…"). Cách đúng: address-list (thêm lợi fail-closed).
const NO_COMMA_FIELDS = ["src-address", "dst-address"];

const FIREWALL_MENU = /^\/(ip|ipv6)\/firewall\/(filter|nat|mangle|raw)$/;

/**
 * Kiểm body sắp ghi. `merged` = object hiện có + thay đổi (với set) — vì `protocol` có thể đã
 * nằm sẵn trên rule. Ném AxiError VALIDATION_ERROR (exit 2) kèm cách làm đúng.
 */
export function validateWrite(menu: string, body: RosBody, merged: RosBody = body): void {
  if (menu === "/ip/service" && "address" in body) {
    // Bẫy #5: `address` là tên cũ, luôn rỗng; ghi vào đó KHÔNG lỗi và KHÔNG tác dụng.
    fail("/ip/service `address` has no effect on RouterOS v7", "VALIDATION_ERROR", [
      "Set `available-from` instead: that field holds the real service ACL",
    ]);
  }

  for (const field of NO_COMMA_FIELDS) {
    const v = body[field];
    if (v !== undefined && v.includes(",")) {
      fail(`${field} does not accept a comma-separated list: ${v}`, "VALIDATION_ERROR", [
        `Put the addresses in an address-list and use \`${field}-list\` instead`,
        "Add one /ip/firewall/address-list entry per address",
      ]);
    }
  }

  if (FIREWALL_MENU.test(menu)) {
    const protocol = merged["protocol"];
    if (protocol !== undefined && protocol.includes(",")) {
      fail(`protocol accepts a single value, got: ${protocol}`, "VALIDATION_ERROR", [
        "Create one rule per protocol (e.g. one for tcp, one for udp)",
      ]);
    }
    for (const port of ["dst-port", "src-port"]) {
      if (merged[port] && !protocol) {
        fail(`${port} requires protocol to be set`, "VALIDATION_ERROR", [
          "Add protocol=tcp or protocol=udp to the same rule",
        ]);
      }
    }
  }
}
