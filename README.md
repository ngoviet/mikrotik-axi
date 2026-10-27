# mikrotik-axi

<!-- readme-axi type=tool -->

**English** · [Tiếng Việt](README.vi.md)

An [AXI](https://axi.md) for **MikroTik RouterOS v7**: a CLI that coding agents (Claude Code,
Codex, OpenCode, …) call through the shell to inspect and carefully operate routers and
switches over the REST API.

> 🇻🇳 Built and maintained by one person in Việt Nam — if it saves you time, please
> [support the project](#support-the-project).

## Contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Commands](#commands)
- [Agent integration](#agent-integration)
- [Development](#development)

## Features

- **Compact output.** [TOON](https://toonformat.dev/), ≤ 4 columns by default, aggregates
  precomputed, `help[]` hints for the next step.
- **RouterOS traps handled inside the tool.** Agents do not have to rediscover them:
  - adding objects goes through `<menu>/add`;
  - `.id` values keep their `*`;
  - fields that reject comma lists are checked before sending;
  - singleton menus are handled separately;
  - the `/ip/service` ACL is read from `available-from`;
  - dynamic routes are refused;
  - every REST value arrives as a string;
  - default routes are counted per routing table, never merged.
- **Safe by default.** The tool checks the device identity before anything else. Writes are
  dry-run unless `--confirm`, take a snapshot first, are read back to confirm they took effect,
  and come with a one-line revert.

## Installation

Requires Node.js ≥ 20.

```sh
npm install -g mikrotik-axi
```

## Configuration

Three steps: a RouterOS user for the tool, a profile, and credentials.

### 1. Create a RouterOS user for the tool

Do **not** use `admin`. Create a dedicated user limited to your workstation's address.

```routeros
/user group add name=axi-read policy=read,api,rest-api
/user add name=axi-ro group=axi-read address=192.168.88.10/32 password=<long random>
```

Check the policy names against `/user group print` on your version: a wrong name means
REST answers 401/403. For write commands, add a second user whose group also has `write`. Keep `policy`,
`password`, `sensitive`, `ftp` and `reboot` out of it.

Prefer HTTPS (`/ip service enable www-ssl` with a certificate). For a self-signed
certificate, pin its SHA-256 fingerprint in the profile. The first `https` run prints the
fingerprint it saw, so you can compare it with `/certificate print detail`. Plain `http://`
works but prints a warning on every run.

### 2. Write a profile

`%APPDATA%\mikrotik-axi\profile.json` on Windows, `~/.config/mikrotik-axi/profile.json`
elsewhere. You can also pass `--profile <path>` or set `MIKROTIK_AXI_PROFILE`. See
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

The profile fields:

- `expect_identity` is required. An IP address is not an identity: another network can reuse
  the same subnet. The tool first probes **without credentials**, continues only if a RouterOS
  answers, and then compares `/system/identity` with this value.
- `line_map` only labels ports. The tool derives which physical port each PPPoE session rides
  on by following pppoe → vrrp/vlan → port.
- `protected` lists objects that write commands refuse to touch.
- `credential_env_write` (optional) names the variables of a user **with** the `write` policy. Only
  write commands use it; read commands and the session hook keep using `credential_env`, so the
  write-capable password is never loaded for a read.

### 3. Credentials

Credentials come only from environment variables, never from the profile:
`MIKROTIK_AXI_USER` / `MIKROTIK_AXI_PASS`, or the variable names given in `credential_env`.
`MIKROTIK_AXI_ENV_FILE=<path>` loads a private `KEY=VALUE` file without overriding variables
that are already set. Passwords are never printed. Authentication errors show only the user
name, the password length and a hash prefix.

## Usage

Run `mikrotik-axi` with no command (or `home`) for an overview of the default device:

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

## Commands

| Command | Returns |
| --- | --- |
| *(none)* / `home` | health, WAN, main default route, DHCP, alerts |
| `devices` | every profile device: identity check, version, reachability |
| `health` | board, version, uptime, CPU, memory, temperature, update status |
| `wan [ips]` | PPPoE sessions per physical line; public IP per session, shared IPs flagged |
| `routes defaults [--table t]` | default routes **per routing table**, tables with 0 or >1 active |
| `routes rules` | `/routing/rule`, marking rules a mangle `mark-routing` already decides |
| `dhcp [leases <server>]` | servers, bound/total, pool usage (≥ 90% flagged) |
| `vlans`, `iface [--type …]` | VLANs with addresses; interfaces with counters |
| `fw <filter\|nat\|mangle\|raw> [--chain c]` | rules in processing order, per-chain counts, zero-hit rules |
| `fw mangle check` | `change-mss` after the first `accept`, MSS-raising rules, duplicate marks |
| `services` | management services and their real ACL (`available-from`) |
| `log [--topic t] [--since 1h] [--grep re]` | recent log; `--since` uses the router's clock |

Every command accepts `--device`, `--fields a,b`, `--full` and `--help`. Unknown flags exit 2
and list the valid ones. Errors go to stdout as `error:` / `code:` / `help:`.

### Writes

| Command | Change |
| --- | --- |
| `fw <table> enable\|disable <.id>` | toggle one rule |
| `addr-list add\|remove <list> <address>` | one address-list entry |
| `pppoe restart <name>` | disable + enable one PPPoE client |
| `arp flush <address>` | drop one dynamic ARP entry |
| `revert <snapshot>` | undo a change from its snapshot |

Every write goes through the same steps:

1. Verify the identity (cannot be skipped).
2. Refuse protected and dynamic objects.
3. Read the current state.
4. Without `--confirm`, print the plan and stop.
5. With `--confirm`: snapshot, write, read back (a write that silently did nothing exits 1),
   and print `mikrotik-axi revert <snapshot> --confirm`.

A target already in the wanted state gives `result: no-op`. `MIKROTIK_AXI_READ_ONLY=1`
refuses every write. No command runs arbitrary RouterOS scripts.

## Agent integration

- **Session hook:** `mikrotik-axi setup hooks` installs a SessionStart hook for Claude Code,
  Codex and OpenCode (`--status`, `--remove`, `--scope project`). It runs
  `mikrotik-axi-hook`, which prints the home view read-only, finishes within a 3 s budget, and
  prints a single line when the router is unreachable. Set `MIKROTIK_AXI_HOOK_DIRS` (`;` on
  Windows, `:` elsewhere) to the projects that should see router context; elsewhere the hook
  prints nothing.
- **Skill:** [`skill/SKILL.md`](skill/SKILL.md) is generated from the command registry, for
  agents that load skills on demand.

## Development

```sh
pnpm install
pnpm check                   # typecheck + lint + unit/contract tests (no network)
pnpm build                   # dist/bin/mikrotik-axi.js, dist/bin/mikrotik-axi-hook.js
pnpm skill:build             # regenerate skill/SKILL.md (tests fail when stale)
pnpm fixtures:synthetic      # regenerate the synthetic test fixtures
MIKROTIK_AXI_LIVE=1 pnpm test:live          # read-only checks against your router
MIKROTIK_AXI_LIVE_WRITE=1 pnpm test:live    # write cycle on AXI_TEST objects only
pnpm fixtures:record --device core          # record sanitized, anonymized fixtures
```

Tests run against a fake RouterOS REST server built from the fixtures in `test/fixtures/`.

<!-- support:start -->
## Support the project

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

<p align="center"><sub>🇻🇳 VietQR: scan with any Vietnamese banking app, transfer note <code>Ung ho mikrotik-axi</code>. Thank you for keeping this project alive!</sub></p>
<p align="center"><sub>Crypto (BEP20 network): <code>0xcbf0402b232cb24b4d998f09a4884f87b5f74750</code> · USDT · USDC · BNB · ETH · BTC</sub></p>
<!-- support:end -->

## License

[MIT](LICENSE) © Ngô Đức Việt. Not affiliated with or endorsed by MikroTik.
