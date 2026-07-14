# NamingSignal

Evidence-first product naming for agents and founders. NamingSignal generates broad, diverse name fields, checks exact domain registry evidence (RDAP) and developer namespaces, and researches finalists with sources and timestamps instead of vibes. Registry not-found is reported as likely unregistered, never as a purchase guarantee.

This repository contains the open-source clients and the deterministic naming core:

| Package | What it is | Install |
| --- | --- | --- |
| [`@namingsignal/mcp`](packages/mcp) | Stdio MCP server exposing five read-only naming tools backed by the hosted API | `npx -y @namingsignal/mcp` |
| [`@namingsignal/cli`](packages/cli) | CLI with keyless local commands (RDAP checks, privacy-bounded briefs, deterministic generation, decision records) plus hosted research | `npm install -g @namingsignal/cli` |

## Quick links

- Site: https://namingsignal.com
- Developer docs and API keys: https://namingsignal.com/developers
- Hosted agent guide: https://namingsignal.com/agent-guide.txt
- OpenAPI contract: https://namingsignal.com/openapi.json (a static snapshot lives in [`openapi.json`](openapi.json))
- Agent workflow guide: [`docs/agent-workflow.md`](docs/agent-workflow.md)

## Remote MCP, no install

The fastest integration is the hosted Streamable HTTP MCP endpoint. Create a free API key at https://namingsignal.com/developers/keys, then:

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

Prefer a local process? Use the stdio package instead; see [`packages/mcp`](packages/mcp/README.md).

## Keyless local check

```bash
npx -y @namingsignal/cli check offhook nicless --tlds com,app --json
```

Live RDAP registry evidence, transparent scoring, and honest unknowns, with no account and no API key.

## Scope of this repository

This repo contains the MCP and CLI clients plus the deterministic core they share: RDAP domain checking with calibration, exact namespace checks (npm, PyPI, GitHub, Apple), the brief compiler, import safety bounds, the transparent scoring rubric, and decision-record export. The hosted orchestration (model-led generation, editorial ranking, finalist research providers, accounts, and metering) runs at namingsignal.com and is not in this repo.

## Contributing

Issues and pull requests are welcome at https://github.com/moekoelueker/namingsignal/issues. Please do not file security reports as public issues; see https://namingsignal.com for contact details.

## License

MIT, Copyright (c) 2026 Zena Labs LLC. See [LICENSE](LICENSE).

NamingSignal output is preliminary business research, not legal advice, trademark clearance, or a registrar guarantee.
