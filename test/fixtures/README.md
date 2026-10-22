# Fixture

- `ccr2004/`, `crs326/` — **tổng hợp** (không ghi từ máy thật), sinh bởi `pnpm fixtures:synthetic`
  (`scripts/gen-synthetic-fixtures.mjs`): một CCR2004 đa WAN (40 phiên PPPoE + một phiên nháp đã
  tắt, `vrrpN` bám thẳng ether1–5, 40 default route trong `main` + bảng `to-poN`, 43 DHCP
  server) và một switch CRS326. Đổi dữ liệu ⇒ sửa generator rồi chạy lại, không sửa JSON tay.
  IP công khai thuộc dải tài liệu RFC 5737.
- `<device>-recorded/` — bản ghi thật đã làm sạch + ẩn danh (`pnpm fixtures:record`). Đọc lại
  trước khi commit.
- `foreign/` — thiết bị KHÔNG phải RouterOS (router ZTE trả 404 HTML) để test identity guard.
- `tls/` — cert tự ký CHỈ dùng cho test transport.

Tên file = menu REST, `/` đổi thành `__`: `/ip/dhcp-server/lease` → `ip__dhcp-server__lease.json`.
Mọi giá trị nhạy cảm phải là `"***"` — `test/fixtures.test.ts` quét và fail nếu thấy khác.
