# Hardware AI/EDA tooling

Tooling that lets Claude Code (and you) source parts, design schematics from code,
and drive KiCad for PCB work. Written for macOS / Apple Silicon with KiCad 9.

## What's installed

| Capability | Tool | Status |
|---|---|---|
| JLCPCB part search | [`jlc-search`](./jlc-search) (this dir, on PATH) | ✅ live data |
| Schematic from code | pcbc — see [`../DS2Addon/pcbc/`](../DS2Addon/pcbc) | used for DS2 Addon rev 2 |
| PCB layout + live state + DRC/ERC | `kicad-mcp-pro` MCP server via [`../../.mcp.json`](../../.mcp.json) | ✅ read-only by default |
| `kicad-cli` on PATH | symlink → `/opt/homebrew/bin/kicad-cli` | ✅ 9.0.6 |

Prereq: `uv` (Homebrew), which runs the MCP server.

## 1. JLCPCB search — `jlc-search`

```bash
jlc-search "STM32G030"                          # ICs, by stock
jlc-search "0.1uF 0402" --basic --sort price    # Basic parts, cheapest first
jlc-search "10k 0402" --min-stock 500000 --json # raw JSON, for scripting
```
Hits the tscircuit JLC mirror (`jlcsearch.tscircuit.com`); no API key. Returns the
JLCPCB part number (`C…`), Basic/Extended, package, stock, unit price.

## 2. Schematic design from code — pcbc

Boards described in code use the pcbc tool; the DS2 Addon rev 2 under
[`../DS2Addon/pcbc/`](../DS2Addon/pcbc) (`ds2_addon.py`) is the example in this repo.

## 3. PCB layout + live state — `kicad` MCP server

Configured in [`../../.mcp.json`](../../.mcp.json) as a project-scoped server:
`kicad-mcp-pro==3.9.2` (pinned), `--profile pcb_only`, **`--mode readonly`**, `--project-dir` → DS2Addon.

### To actually use the live tools
1. **Launch KiCad**, open the board you want.
2. KiCad → **Preferences → Plugins → enable "Enable IPC API server"** (required; the server
   connects lazily and will otherwise log `Connection refused`).
3. In Claude Code, **approve the project MCP server** when prompted (reload the extension if it
   doesn't appear). 41 read-only tools become available: `pcb_get_board_summary`, `pcb_get_nets`,
   `pcb_get_ratsnest`, `pcb_get_design_rules`, `pcb_check_creepage_clearance`, etc.

### To switch which board
Edit `../../.mcp.json` → `--project-dir` to e.g.
`<repo>/Hardware/EdgeBoard/KiCad` (an absolute path).

### To enable editing / autorouting (opt-in, higher risk)
- **Editing:** change `--mode readonly` → `--mode write`. Recommended: point `--project-dir`
  at a *dedicated working copy* under git, not your canonical board, and review diffs per session.
- **FreeRouting autoroute:** omitted on purpose (the Docker path widens a bind-mount and pins a
  mutable image tag). To add: supply a vetted local jar via `KICAD_MCP_FREEROUTING_JAR` env.

## Security / maintenance notes
- `kicad-mcp-pro` is pinned to `==3.9.2` (audited commit `cac8fdb`). It's a young, single-maintainer
  repo — **re-audit on every version bump** before upgrading the pin. Telemetry is off by default;
  keep it off. Risk reviewed as *medium, safe-to-install* under these settings.
- The `.mcp.json` contains **machine-specific absolute paths**. Fine locally; adjust before relying
  on it from another machine.
- KiCad kept at **9.0.6**. KiCad 10 (`brew install --cask kicad`) replaces 9 in-place and can touch
  board file formats — upgrade deliberately, not mid-task. The IPC API is PCB-only on both 9 and 10
  (no schematic/eeschema API), so the MCP server cannot edit schematics.
