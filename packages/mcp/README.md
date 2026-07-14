# @namingsignal/mcp

Stdio [Model Context Protocol](https://modelcontextprotocol.io) server for [NamingSignal](https://namingsignal.com): evidence-first product naming with exact domain registry checks, developer namespace checks, and source-backed finalist research. All five tools are read-only and are metered through the NamingSignal account attached to your API key.

Create a free API key at https://namingsignal.com/developers/keys.

## Fastest option: remote MCP, no install

NamingSignal also serves the identical tool surface over Streamable HTTP at `https://namingsignal.com/mcp`. If your client supports remote MCP servers, you do not need this package at all.

Claude Code:

```bash
claude mcp add --transport http naming-signal https://namingsignal.com/mcp \
  --header "Authorization: Bearer YOUR_NAMINGSIGNAL_KEY"
```

Codex `~/.codex/config.toml`:

```toml
experimental_use_rmcp_client = true

[mcp_servers.naming_signal]
url = "https://namingsignal.com/mcp"
bearer_token_env_var = "NAMING_SIGNAL_API_KEY"
```

## Stdio setup

The stdio server runs locally and calls the hosted REST API (default `https://namingsignal.com`).

Claude Code:

```bash
claude mcp add naming-signal \
  --env NAMING_SIGNAL_API_KEY=YOUR_NAMINGSIGNAL_KEY \
  -- npx -y @namingsignal/mcp
```

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.naming_signal]
command = "npx"
args = ["-y", "@namingsignal/mcp"]
env = { NAMING_SIGNAL_API_KEY = "YOUR_NAMINGSIGNAL_KEY" }
tool_timeout_sec = 360
```

Large sprints (150 to 200 names across several TLDs) can take minutes in one synchronous tool call; raise your client's tool timeout (Codex `tool_timeout_sec = 360`) before running one.

### Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `NAMING_SIGNAL_API_KEY` | Yes, for hosted tool calls | User API key created at https://namingsignal.com/developers/keys. Sent as the Authorization Bearer header, never logged. |
| `NAMING_SIGNAL_API_URL` | No | API origin. Defaults to `https://namingsignal.com`; set `http://localhost:3000` when running the API locally. |

## The five tools

- `compile_project_brief`: turn a sentence, prompt, or README into a bounded, editable naming brief; missing fields stay explicit instead of being invented.
- `create_naming_sprint`: generate and check 10 to 200 names across up to five TLDs, with feedback rounds (`feedback`, `likedNames`, `dislikedNames`, `existingNames`) and an optional full ledger (`includeLedger: true`).
- `check_names`: exact domain registry evidence and optional npm/PyPI/GitHub/Apple namespace checks for up to 100 names.
- `analyze_candidates`: deeper source-backed research for one to three finalists, with explicit unknowns and manual checks.
- `get_purchase_links`: exact-domain registrar search links for manual verification; it never purchases or reserves anything.

Tool output is compact by default; pass `verbose: true` only when full evidence objects are required.

## Evidence honesty

Registry RDAP not-found means likely unregistered at check time, not guaranteed registrability, registrar price, or trademark clearance. Timeout, rate limit, unsupported TLD, failed calibration, and missing research remain unknown and are never converted into available. Recheck every finalist at a registrar before purchase; naming research is not legal clearance.

## License

MIT, Copyright (c) 2026 Zena Labs LLC.
