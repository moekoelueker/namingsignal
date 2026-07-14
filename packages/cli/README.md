# @namingsignal/cli

CLI for [NamingSignal](https://namingsignal.com): evidence-backed product naming for developers and agents. Local commands are keyless and deterministic; hosted commands call the NamingSignal REST API with your own key.

## Install

```bash
npm install -g @namingsignal/cli
# or run without installing
npx -y @namingsignal/cli help
```

Requires Node 20 or newer.

## Keyless local commands

No account, no API key, no telemetry. Domain checks talk directly to public RDAP registries from your machine.

```bash
# Score names and run live registry checks
namingsignal check offhook nicless --tlds com,app --namespaces --json

# Compile a privacy-bounded naming brief from a repository or file
namingsignal brief /path/to/project --dry-run
namingsignal brief /path/to/project --out naming-brief.json

# Deterministic candidate generation from an approved brief (degraded-mode starting set)
namingsignal generate --brief naming-brief.json --count 40

# Portable decision record from prior evidence
namingsignal compare offhook quitcore --brief naming-brief.json --evidence prior-check.json --format md
```

The `brief` scanner is allowlisted and bounded: it reads README/agent instructions/manifests/docs text only, excludes source code, `.env` files, credentials, lockfiles, and build output, and `--dry-run` previews the exact file selection before anything is compiled.

## Hosted commands

`research` and `health` call the hosted API (default `https://namingsignal.com`). Create a free key at https://namingsignal.com/developers/keys and export it; never commit it.

```bash
export NAMING_SIGNAL_API_KEY=your-user-key

namingsignal research offhook quitcore nicless --brief naming-brief.json
namingsignal health
```

`--api <url>` or `NAMING_SIGNAL_API_URL` overrides the API origin (for example `http://localhost:3000` for a local development server).

## JSON mode

Machine-readable JSON is written to stdout whenever `--json` is passed or stdout is not a TTY, so agent pipelines get structured output by default. Diagnostics go to stderr.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected or network error |
| 2 | Usage error |
| 3 | Auth error (401/403) |
| 4 | Quota or rate limit (402/429) |

## Evidence honesty

RDAP not-found means likely unregistered at check time, not a purchase guarantee. Timeouts, rate limits, and unsupported TLDs stay unknown and are never reported as available. Naming research is preliminary; it is not trademark clearance or legal advice.

## License

MIT, Copyright (c) 2026 Zena Labs LLC.
