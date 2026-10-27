# mikrotik-axi

<!-- readme-axi type=tool -->

[English](README.md) · **Tiếng Việt**

Một [AXI](https://axi.md) cho **MikroTik RouterOS v7**: CLI để coding agent (Claude Code, Codex, OpenCode, …)
gọi qua shell nhằm xem trạng thái và thao tác cẩn thận trên router, switch qua REST API.

> 🇻🇳 Dự án do một người Việt tự xây dựng và duy trì — nếu nó giúp ích cho bạn, hãy
> [ủng hộ dự án](#ủng-hộ-dự-án).

## Mục lục

- [Tính năng](#tính-năng)
- [Cài đặt](#cài-đặt)
- [Cấu hình](#cấu-hình)
- [Cách dùng](#cách-dùng)
- [Lệnh](#lệnh)
- [Tích hợp với agent](#tích-hợp-với-agent)
- [Phát triển](#phát-triển)

## Tính năng

- **Output gọn.** [TOON](https://toonformat.dev/), mặc định ≤ 4 cột, số tổng tính sẵn, gợi ý `help[]` cho bước
  tiếp theo.
- **Các bẫy của RouterOS được xử lý ngay trong công cụ.** Agent không phải tự mò lại:
  - thêm đối tượng đi qua `<menu>/add`;
  - giá trị `.id` giữ nguyên dấu `*`;
  - trường không nhận danh sách phân tách bằng dấu phẩy được kiểm tra trước khi gửi;
  - menu singleton được xử lý riêng;
  - ACL của `/ip/service` đọc từ `available-from`;
  - route động bị từ chối;
  - mọi giá trị REST trả về đều là chuỗi;
  - default route được đếm theo từng routing table, không bao giờ gộp chung.
- **An toàn mặc định.** Công cụ kiểm tra identity của thiết bị trước mọi việc khác. Lệnh ghi chỉ chạy thử
  (dry-run) nếu không có `--confirm`, luôn chụp snapshot trước, đọc lại để xác nhận đã có hiệu lực, và kèm một
  lệnh hoàn tác trên một dòng.

## Cài đặt

Cần Node.js ≥ 20.

```sh
npm install -g mikrotik-axi
```

## Cấu hình

Ba bước: tạo user RouterOS cho công cụ, viết profile, và khai báo thông tin đăng nhập.

### 1. Tạo user RouterOS cho công cụ

**Đừng** dùng `admin`. Tạo một user riêng, chỉ cho phép từ địa chỉ máy trạm của bạn.

```routeros
/user group add name=axi-read policy=read,api,rest-api
/user add name=axi-ro group=axi-read address=192.168.88.10/32 password=<long random>
```

Đối chiếu tên policy với `/user group print` trên phiên bản của bạn: sai tên thì REST trả về 401/403. Với lệnh
ghi, thêm user thứ hai có group kèm thêm `write`. Không cho group đó các quyền `policy`, `password`, `sensitive`,
`ftp` và `reboot`.

Nên dùng HTTPS (`/ip service enable www-ssl` kèm chứng chỉ). Với chứng chỉ tự ký, ghim (pin) dấu vân tay SHA-256
của nó trong profile. Lần chạy `https` đầu tiên sẽ in dấu vân tay nó thấy, để bạn so với
`/certificate print detail`. `http://` thường vẫn chạy nhưng in cảnh báo ở mọi lần chạy.

### 2. Viết profile

`%APPDATA%\mikrotik-axi\profile.json` trên Windows, `~/.config/mikrotik-axi/profile.json` trên hệ khác. Cũng có
thể truyền `--profile <path>` hoặc đặt `MIKROTIK_AXI_PROFILE`. Xem
[`profiles/example.json`](profiles/example.json).

```json
{
  "default": "core",
  "devices": {
    "core": {
      "url": "https://192.168.88.1",
      "expect_identity": "CORE-ROUTER",
      "tls": { "self_signed_pin_sha256": "AB:CD:…" },
      "line_map": { "ether1": "Line 1", "ether2": "Line 2" },
      "expect": { "pppoe_running": 16, "main_default_gateway": "pppoe-out1" },
      "protected": { "nat_dst_ports": [80, 443], "comment_prefixes": ["HA_"] },
      "alerts": { "disabled": [] }
    },
    "switch": { "url": "https://192.168.88.2", "expect_identity": "ACCESS-SWITCH",
                "credential_env": { "user": "SWITCH_AXI_USER", "pass": "SWITCH_AXI_PASS" } }
  }
}
```

Các trường của profile:

- `expect_identity` là bắt buộc. Địa chỉ IP không phải là identity: một mạng khác có thể dùng lại cùng subnet.
  Công cụ dò trước **không kèm thông tin đăng nhập**, chỉ đi tiếp nếu có RouterOS trả lời, rồi so
  `/system/identity` với giá trị này.
- `line_map` chỉ để đặt nhãn cho cổng. Công cụ tự suy ra mỗi phiên PPPoE chạy trên cổng vật lý nào bằng cách lần
  theo pppoe → vrrp/vlan → cổng.
- `protected` liệt kê các đối tượng mà lệnh ghi từ chối đụng vào.
- `credential_env_write` (tuỳ chọn) đặt tên các biến của một user **có** policy `write`. Chỉ lệnh ghi dùng nó;
  lệnh đọc và session hook vẫn dùng `credential_env`, nên mật khẩu có quyền ghi không bao giờ được nạp cho một
  lệnh đọc.

### 3. Thông tin đăng nhập

Thông tin đăng nhập chỉ lấy từ biến môi trường, không bao giờ từ profile: `MIKROTIK_AXI_USER` /
`MIKROTIK_AXI_PASS`, hoặc các tên biến ghi trong `credential_env`. `MIKROTIK_AXI_ENV_FILE=<path>` nạp một file
`KEY=VALUE` riêng tư mà không ghi đè các biến đã đặt sẵn. Mật khẩu không bao giờ được in ra. Lỗi xác thực chỉ hiện
tên user, độ dài mật khẩu và phần đầu của một mã băm.

## Cách dùng

Chạy `mikrotik-axi` không kèm lệnh (hoặc `home`) để xem tổng quan thiết bị mặc định:

```
$ mikrotik-axi
bin: ~/AppData/Roaming/npm/mikrotik-axi
description: Inspect and safely operate MikroTik RouterOS v7 devices over REST
device: "core (identity CORE-ROUTER ok, RouterOS 7.24.4 (stable), up 12d4h)"
health: "cpu 6%, mem 18%, temp 47C"
wan: 40/40 pppoe running (1 disabled) · lines 8/8/8/8/8
main_default: pppoe-out1 (1 active of 40)
dhcp: 43 servers · 233 bound
alerts[3]{id,message}:
  no-netwatch,no netwatch or check-gateway for main default (ISP route loss undetected)
  mac-server,mac-telnet and mac-winbox allowed on all interfaces
  dup-mark,"duplicate mark-routing: Mark-V239 ×2, Mark-V240 ×2"
help[2]: Run `mikrotik-axi fw mangle check` to audit rule order,Run `mikrotik-axi wan` for per-session status
```

## Lệnh

| Lệnh | Trả về |
| --- | --- |
| *(không có)* / `home` | sức khoẻ thiết bị, WAN, default route chính, DHCP, cảnh báo |
| `devices` | mọi thiết bị trong profile: kiểm tra identity, phiên bản, có kết nối được không |
| `health` | board, phiên bản, uptime, CPU, bộ nhớ, nhiệt độ, trạng thái cập nhật |
| `wan [ips]` | phiên PPPoE theo từng đường vật lý; IP public của từng phiên, đánh dấu IP bị dùng chung |
| `routes defaults [--table t]` | default route **theo từng routing table**, các table có 0 hoặc >1 route active |
| `routes rules` | `/routing/rule`, các rule đánh dấu mà mangle `mark-routing` đã quyết định rồi |
| `dhcp [leases <server>]` | server, số bound/tổng, mức dùng pool (≥ 90% bị đánh dấu) |
| `vlans`, `iface [--type …]` | VLAN kèm địa chỉ; interface kèm bộ đếm |
| `fw <filter\|nat\|mangle\|raw> [--chain c]` | rule theo thứ tự xử lý, số lượng theo chain, rule chưa khớp lần nào |
| `fw mangle check` | `change-mss` nằm sau `accept` đầu tiên, rule làm tăng MSS, mark trùng |
| `services` | dịch vụ quản trị và ACL thực tế của chúng (`available-from`) |
| `log [--topic t] [--since 1h] [--grep re]` | log gần đây; `--since` tính theo đồng hồ của router |

Mọi lệnh đều nhận `--device`, `--fields a,b`, `--full` và `--help`. Cờ không hợp lệ thoát với mã 2 và liệt kê các
cờ hợp lệ. Lỗi in ra stdout dạng `error:` / `code:` / `help:`.

### Lệnh ghi

| Lệnh | Thay đổi |
| --- | --- |
| `fw <table> enable\|disable <.id>` | bật/tắt một rule |
| `addr-list add\|remove <list> <address>` | một mục address-list |
| `pppoe restart <name>` | disable + enable một PPPoE client |
| `arp flush <address>` | xoá một mục ARP động |
| `revert <snapshot>` | hoàn tác một thay đổi từ snapshot của nó |

Mọi lệnh ghi đều đi qua cùng các bước:

1. Xác minh identity (không bỏ qua được).
2. Từ chối đối tượng được bảo vệ và đối tượng động.
3. Đọc trạng thái hiện tại.
4. Không có `--confirm` thì in kế hoạch rồi dừng.
5. Có `--confirm`: chụp snapshot, ghi, đọc lại (lệnh ghi mà âm thầm không làm gì sẽ thoát với mã 1), và in
   `mikrotik-axi revert <snapshot> --confirm`.

Đối tượng đã ở đúng trạng thái mong muốn thì cho `result: no-op`. `MIKROTIK_AXI_READ_ONLY=1` từ chối mọi lệnh ghi.
Không lệnh nào chạy script RouterOS tuỳ ý.

## Tích hợp với agent

- **Session hook:** `mikrotik-axi setup hooks` cài một SessionStart hook cho Claude Code, Codex và OpenCode
  (`--status`, `--remove`, `--scope project`). Hook chạy `mikrotik-axi-hook`, in màn hình tổng quan ở chế độ chỉ
  đọc, xong trong ngân sách 3 giây, và chỉ in một dòng khi không kết nối được router. Đặt `MIKROTIK_AXI_HOOK_DIRS`
  (`;` trên Windows, `:` trên hệ khác) thành các dự án cần thấy ngữ cảnh router; ở nơi khác hook không in gì.
- **Skill:** [`skill/SKILL.md`](skill/SKILL.md) được sinh từ registry lệnh, dành cho agent nạp skill khi cần.

## Phát triển

```sh
pnpm install
pnpm check                   # typecheck + lint + test unit/contract (không cần mạng)
pnpm build                   # dist/bin/mikrotik-axi.js, dist/bin/mikrotik-axi-hook.js
pnpm skill:build             # sinh lại skill/SKILL.md (test báo lỗi khi file cũ)
pnpm fixtures:synthetic      # sinh lại fixture test tổng hợp
MIKROTIK_AXI_LIVE=1 pnpm test:live          # kiểm tra chỉ đọc trên router của bạn
MIKROTIK_AXI_LIVE_WRITE=1 pnpm test:live    # chu trình ghi, chỉ trên đối tượng AXI_TEST
pnpm fixtures:record --device core          # ghi fixture đã làm sạch, ẩn danh hoá
```

Test chạy với một REST server RouterOS giả, dựng từ các fixture trong `test/fixtures/`.

<!-- support:start -->
## Ủng hộ dự án

<p align="center">
  <img src="https://raw.githubusercontent.com/ngoviet/.github/main/assets/support/banner.svg" width="720" alt="Built and maintained by one person in Việt Nam">
</p>

<p align="center">
  <a href="https://buymeacoffee.com/ngoviet"><img src="https://raw.githubusercontent.com/ngoviet/.github/main/assets/support/btn-coffee.svg" height="56" alt="Buy me a coffee"></a>
  &nbsp;
  <a href="https://github.com/sponsors/ngoviet"><img src="https://raw.githubusercontent.com/ngoviet/.github/main/assets/support/btn-sponsors.svg" height="56" alt="GitHub Sponsors"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ngoviet/.github/main/assets/support/vietqr-card.svg" width="300" alt="VietQR — MB Bank — NGO DUC VIET — 911051212">
</p>

<p align="center"><sub>🇻🇳 VietQR: quét bằng app ngân hàng bất kỳ, nội dung <code>Ung ho mikrotik-axi</code>. Cảm ơn bạn đã giúp dự án tiếp tục phát triển!</sub></p>
<p align="center"><sub>Tiền mã hoá (mạng BEP20): <code>0x57f07d44fb581cddc028a0c67d63a8cc05aa6caa</code> · USDT · USDC · BNB · ETH · BTC</sub></p>
<!-- support:end -->

## Giấy phép

[MIT](LICENSE) © Ngô Đức Việt. Không liên kết hay được MikroTik bảo trợ.
