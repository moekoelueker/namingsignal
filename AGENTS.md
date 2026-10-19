# NamingSignal open source: agent brief

The open-source clients of NamingSignal, an evidence-first product-naming service: `@namingsignal/mcp` (a stdio MCP server with five read-only naming tools backed by the hosted API) and `@namingsignal/cli` (keyless local RDAP and namespace checks, briefs, deterministic generation and decision records, plus hosted research). Both share the deterministic naming core.
Status: both packages are 0.2.0 on npm (published 2026-07-14); the MCP server is `com.namingsignal/naming-signal`. MIT licensed. TypeScript, Node 20 or newer, npm workspaces. The hosted orchestration (model-led generation, ranking, finalist research, accounts, metering) runs at https://namingsignal.com and is not in this repository.

## Hard rules

- This repository is public. Tracked files hold technical notes only: no credentials, API keys, local paths, personal details or business plans.
- Each package carries its own copy of the deterministic core in `src/core/`. Change both copies together and keep them identical: `diff -r packages/cli/src/core packages/mcp/src/core` must print nothing.
- Registry not-found is "likely unregistered", never a purchase guarantee. A failed check, timeout or unsupported source stays unknown. Output is preliminary research, never legal advice or trademark clearance.
- Never ship or log an API key. Hosted calls read `NAMING_SIGNAL_API_KEY` from the environment.
- Publishing to npm or the MCP Registry, tagging a release or pushing needs the owner's explicit approval.
- `openapi.json` is a static snapshot of https://namingsignal.com/openapi.json; refresh it from there.

## Commands

- Install: `npm install`
- Build (must pass before a commit; there is no test suite here yet): `npm run build`
- Pack both packages to inspect what would ship: `npm run pack:all`
- Try the CLI after a build: `node packages/cli/dist/index.js check offhook --tlds com,app --json`
- Publishing: there is no release workflow in this repository. Each package's `prepack` builds it; publish only on the owner's approval.

## Map

- `packages/cli/`: `@namingsignal/cli` (`packages/cli/src/index.ts`, `packages/cli/src/core/`, `packages/cli/README.md`).
- `packages/mcp/`: `@namingsignal/mcp` (`packages/mcp/src/index.ts` starts it, `packages/mcp/src/server-core.ts` registers the tools, `packages/mcp/src/agent-guidance.ts`, `packages/mcp/src/core/`, `packages/mcp/README.md`).
- `docs/agent-workflow.md`: how an agent should drive a naming run end to end.
- `openapi.json`: the hosted API contract snapshot.
- `docs/DECISIONS.md`: decisions of record, newest first.
- `docs/handoff/CURRENT.md`: where things stand right now. Read it before starting work.

## Session close

Run the `session-close` skill at the end of substantial work. Routing for this repo:
- Decisions: `docs/DECISIONS.md` (newest first, `[YYYY-MM-DD] DECISION: ... | REASONING: ... | CONTEXT: ...`)
- Current state: rewrite `docs/handoff/CURRENT.md` (80 lines max)
- Dated handoff: `docs/handoff/YYYY-MM-DD.md`
- This repository is public: decisions and handoffs here hold technical notes only. Anything private belongs in the owner's private notes, outside this repository.
