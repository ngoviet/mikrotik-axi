// Bẫy #4: menu SINGLETON trả dict (không phải list) và sửa bằng POST <menu>/set, không PATCH.
// Khai báo TẬP TRUNG ở đây — mọi chỗ khác hỏi qua isSingleton().
const SINGLETON_MENUS = new Set([
  "/system/identity",
  "/system/resource",
  "/system/clock",
  "/system/routerboard",
  "/system/routerboard/settings",
  "/system/package/update",
  "/system/note",
  "/system/ntp/client",
  "/system/ntp/server",
  "/ip/settings",
  "/ipv6/settings",
  "/ip/dns",
  "/ip/cloud",
  "/ip/proxy",
  "/ip/socks",
  "/ip/ssh",
  "/ip/upnp",
  "/ip/neighbor/discovery-settings",
  "/interface/detect-internet",
  "/snmp",
  "/user/settings",
  "/certificate/settings",
]);

// Mọi /tool/<x> cấp một (bandwidth-server, mac-server, romon, sniffer, graphing, e-mail…) là
// singleton — bẫy #4 từng vấp ở /tool/bandwidth-server. Các bảng bên dưới là LIST thật.
const TOOL_LIST_MENUS = new Set([
  "/tool/netwatch",
  "/tool/mac-server/sessions",
  "/tool/graphing/interface",
  "/tool/graphing/queue",
  "/tool/graphing/resource",
  "/tool/romon/port",
  "/tool/sms/inbox",
]);

export function isSingleton(menu: string): boolean {
  if (menu.startsWith("/tool/")) return !TOOL_LIST_MENUS.has(menu);
  return SINGLETON_MENUS.has(menu);
}

const MENU_RE = /^\/[a-z0-9][a-z0-9\-/]*[a-z0-9]$/;

export function assertMenu(menu: string): void {
  if (!MENU_RE.test(menu) || menu.includes("//")) {
    throw new Error(`invalid RouterOS menu path: ${menu}`);
  }
}
