# `@ubiquity/supabase-payments-audit`

Historical permit backfill and validation tool for Ubiquity DAO payouts.
Recovers permit data from GitHub issues/comments, validates against on-chain state
(Ethereum + Gnosis), and produces a reconciliation report.

## Architecture

```
scripts/backfill-permits.ts   — Main pipeline orchestrator
src/github-scraper.ts         — Scrape permit data from GitHub issues/comments
src/on-chain-validator.ts     — Validate permits against Ethereum/Gnosis chains
src/reconciliation.ts         — De-duplicate against DB, produce report
src/types.ts                  — Shared TypeScript types
```

## Quick Start

```bash
# Set required env vars
export GITHUB_TOKEN="ghp_..."

# Optional: configure chains and database
export SUPABASE_URL="https://...supabase.co"
export SUPABASE_KEY="eyJ..."
export GNOSIS_RPC_URL="https://rpc.gnosis.gateway.fm"
export GNOSIS_PERMIT_CONTRACT="0x..."
export GNOSISSCAN_API_KEY="..."

# Run the pipeline
npx tsx scripts/backfill-permits.ts
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub PAT with repo read access |
| `ORGANIZATIONS` | No | Comma-separated org list (default: `ubiquity,ubiquity-os`) |
| `SUPABASE_URL` | No | Supabase URL for DB de-duplication |
| `SUPABASE_KEY` | No | Supabase service key |
| `ETHEREUM_RPC_URL` | No | Ethereum RPC endpoint |
| `GNOSIS_RPC_URL` | No | Gnosis RPC endpoint |
| `ETHERSCAN_API_KEY` | No | Etherscan API key |
| `GNOSISSCAN_API_KEY` | No | GnosisScan API key |
| `ETHEREUM_PERMIT_CONTRACT` | No | Permit contract on Ethereum |
| `GNOSIS_PERMIT_CONTRACT` | No | Permit contract on Gnosis |
| `OUTPUT_DIR` | No | Report output dir (default: `./output`) |
| `SKIP_VALIDATION` | No | Set `true` to skip on-chain checks |

## Pipeline Phases

1. **Scrape** — Enumerate all repos in configured orgs, scan issue comments from
   UbiquityOS bots and manual senders (`@0x4007`, `@gentlementlegen`), extract
   base64-encoded permit payloads from claim URLs.

2. **De-duplicate** — Compare scraped permits against the production Supabase database
   using nonce+beneficiary composite keys. Only new permits proceed to validation.

3. **Validate** — For each new permit, check on-chain whether the nonce has been
   consumed (claimed), invalidated (withdrawn), or is still unresolved. Supports both
   Ethereum and Gnosis networks.

4. **Report** — Generate a JSON + Markdown reconciliation report with per-contributor
   and per-repository breakdowns, plus a list of unmatched permits for manual review.

## Output

Reports are written to the configured `OUTPUT_DIR`:

- `reconciliation-<timestamp>.json` — Full structured report
- `reconciliation-<timestamp>.md` — Human-readable summary

---

# `@ubiquity/ts-template`

This template repository includes support for the following:

- TypeScript
- Environment Variables
- Conventional Commits
- Automatic deployment to Cloudflare Pages

## Testing

### Cypress

To test with Cypress Studio UI, run

```shell
yarn cy:open
```

Otherwise, to simply run the tests through the console, run

```shell
yarn cy:run
```

### Jest

To start Jest tests, run

```shell
yarn test
```

## Sync any repository to latest `ts-template`

A bash function that can do this for you:

```bash
sync-branch-to-template() {
  local branch_name
  branch_name=$(git rev-parse --abbrev-ref HEAD)
  local original_remote
  original_remote=$(git remote show | head -n 1)

  # Add the template remote
  git remote add template https://github.com/ubiquity/ts-template

  # Fetch from the template remote
  git fetch template development

  if [ "$branch_name" != "HEAD" ]; then
    # Create a new branch and switch to it
    git checkout -b "chore/merge-${branch_name}-template"

    # Merge the changes from the template remote
    git merge template/development --allow-unrelated-histories

    # Switch back to the original branch
    git checkout "$branch_name"

    # Push the changes to the original remote
    git push "$original_remote" HEAD:"$branch_name"
  else
    echo "You are in a detached HEAD state. Please checkout a branch first."
  fi

  # Remove the template remote
  # git remote remove template
}
```
