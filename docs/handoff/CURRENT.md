# NamingSignal open source: current state

Rewritten in place at each session close (80 lines max). Written 2026-10-18 from git, the README and the npm registry.

## Published

- `@namingsignal/cli` and `@namingsignal/mcp` are 0.2.0 on npm, both published 2026-07-14 (checked with `npm view` on 2026-10-18). The MCP server's registry name is `com.namingsignal/naming-signal`.
- `main` is at `ad23da8`, the initial open-source release (2026-07-14). No commits since.

## Known

- The two `src/core/` copies are identical. The hosted service's core has moved on since 0.2.0 (for example handle variants and changes to candidates and types), so a future release should bring those changes over deliberately, with both copies changed together.
- There is no test suite or CI workflow in this repository; `npm run build` is the only check.

## Next

- Nothing scheduled. A 0.3.0 would start by comparing the core with the hosted service and adding tests for the shared core.
