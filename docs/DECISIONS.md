# Decisions

Decisions of record for the open-source clients, newest first: `[YYYY-MM-DD] DECISION: ... | REASONING: ... | CONTEXT: ...`. Technical notes only; this repository is public. The first entries were collected on 2026-10-18 from the README, the package manifests and the initial release commit.

[2026-07-14] DECISION: Each package ships its own copy of the deterministic core in `src/core/` instead of depending on a shared core package. | REASONING: not recorded at the time; inferred: each npm package installs and runs on its own, with no unpublished internal dependency. | CONTEXT: initial release `ad23da8`; the two copies are identical and must stay so.

[2026-07-14] DECISION: Open-source the MCP and CLI clients and the deterministic core (RDAP checking with calibration, exact namespace checks, the brief compiler, import safety bounds, the scoring rubric, decision-record export); the hosted orchestration (model-led generation, ranking, finalist research, accounts, metering) stays at namingsignal.com. | REASONING: not recorded at the time; inferred from the README: agents and founders can check names locally with no account or key, while paid providers and metering stay server side. | CONTEXT: README "Scope of this repository"; initial release `ad23da8`.

[2026-07-14] DECISION: The MCP server exposes five read-only tools backed by the hosted API, and the CLI's local commands need no key. | REASONING: not recorded at the time; inferred: read-only tools are safe for agents to call freely, and keyless checks lower the barrier to a first run. | CONTEXT: README; `packages/mcp/README.md`.
