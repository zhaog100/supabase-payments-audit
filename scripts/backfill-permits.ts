/**
 * Main backfill script: orchestrates scraping, validation, dedup, and reporting.
 *
 * Usage:
 *   GITHUB_TOKEN=xxx npx tsx scripts/backfill-permits.ts
 *
 * Environment variables:
 *   GITHUB_TOKEN          - Required. GitHub personal access token
 *   ORGANIZATIONS         - Comma-separated list of GitHub orgs (default: ubiquity,ubiquity-os)
 *   SUPABASE_URL          - Supabase project URL for DB dedup
 *   SUPABASE_KEY          - Supabase service key
 *   ETHEREUM_RPC_URL      - Ethereum RPC endpoint
 *   GNOSIS_RPC_URL        - Gnosis RPC endpoint
 *   ETHERSCAN_API_KEY     - Etherscan API key
 *   GNOSISSCAN_API_KEY    - GnosisScan API key
 *   ETHEREUM_PERMIT_CONTRACT - Permit contract on Ethereum
 *   GNOSIS_PERMIT_CONTRACT   - Permit contract on Gnosis
 *   OUTPUT_DIR            - Report output directory (default: ./output)
 *   SKIP_VALIDATION       - Set to "true" to skip on-chain validation
 */
import { scrapePermits } from "../src/github-scraper";
import { validateAllPermits } from "../src/on-chain-validator";
import { deduplicatePermits, mergeValidationResults, generateReport, writeReport } from "../src/reconciliation";
import type { BackfillConfig } from "../src/types";

function loadConfig(): BackfillConfig {
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }

  const organizations = (process.env.ORGANIZATIONS ?? "ubiquity,ubiquity-os").split(",").map((s) => s.trim());

  return {
    githubToken,
    organizations,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    ethereumRpcUrl: process.env.ETHEREUM_RPC_URL,
    gnosisRpcUrl: process.env.GNOSIS_RPC_URL,
    etherscanApiKey: process.env.ETHERSCAN_API_KEY,
    gnosisscanApiKey: process.env.GNOSISSCAN_API_KEY,
    knownFundingWallets: [
      "0x44ca15db101fd1c194467db6af0c67c6bbf4ab51",
      "0x9051eda96db419c967189f4ac303a290f3327680",
      "0xf87ca4583c792212e52720d127e7e0a38b818ad1",
      "0x054ec26398549588f3c958719bd17cc1e6e97c3c",
      "0xefc0e701a824943b469a694ac564aa1eff7ab7dd",
    ],
    ethereumPermitContract: process.env.ETHEREUM_PERMIT_CONTRACT,
    gnosisPermitContract: process.env.GNOSIS_PERMIT_CONTRACT,
    outputDir: process.env.OUTPUT_DIR ?? "./output",
  };
}

async function main(): Promise<void> {
  console.log("=== Historical Permit Backfill Pipeline ===\n");

  const config = loadConfig();

  // Phase 1: Scrape permits from GitHub
  console.log("[Phase 1] Scraping permits from GitHub...");
  const permits = await scrapePermits(config);
  console.log(`Scraped ${permits.length} unique permits\n`);

  if (permits.length === 0) {
    console.log("No permits found. Exiting.");
    return;
  }

  // Phase 2: De-duplicate against database
  console.log("[Phase 2] De-duplicating against database...");
  let entries = await deduplicatePermits(permits, config);

  // Phase 3: On-chain validation (can be skipped)
  const skipValidation = process.env.SKIP_VALIDATION === "true";
  if (skipValidation) {
    console.log("[Phase 3] Skipping on-chain validation (SKIP_VALIDATION=true)");
  } else {
    console.log("[Phase 3] Validating permits on-chain...");
    const newPermits = entries.filter((e) => !e.existsInDatabase).map((e) => e.permit);
    if (newPermits.length > 0) {
      const validations = await validateAllPermits(newPermits, config);
      entries = mergeValidationResults(entries, validations);
    } else {
      console.log("No new permits to validate.");
    }
  }

  // Phase 4: Generate report
  console.log("\n[Phase 4] Generating reconciliation report...");
  const report = generateReport(entries);
  await writeReport(report, config.outputDir);

  // Print summary
  console.log("\n=== Summary ===");
  console.log(`Total scraped:       ${report.summary.totalPermitsScraped}`);
  console.log(`Already in DB:       ${report.summary.alreadyInDatabase}`);
  console.log(`New permits:         ${report.summary.newPermits}`);
  console.log(`Claimed:             ${report.summary.claimed}`);
  console.log(`Withdrawn:           ${report.summary.withdrawn}`);
  console.log(`Assumed withdrawn:   ${report.summary.assumedWithdrawn}`);
  console.log(`Unresolved:          ${report.summary.unresolved}`);
  console.log(`Manual review:       ${report.unmatchedForManualReview.length}`);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
