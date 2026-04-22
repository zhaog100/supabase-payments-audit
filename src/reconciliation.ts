/**
 * Reconciliation: de-duplicates scraped permits against the production database
 * and produces the final reconciliation report.
 */
import type { Permit, ValidationResult, ReconciliationEntry, ReconciliationReport, ReconciliationSummary, BackfillConfig, DatabasePermit } from "./types";
import * as fs from "fs";
import * as path from "path";

/**
 * Fetch existing permits from the production Supabase database.
 * Returns a set of composite keys (nonce:beneficiary) for fast dedup.
 */
async function fetchDatabasePermits(config: BackfillConfig): Promise<Set<string>> {
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.warn("Supabase credentials not configured — skipping DB dedup");
    return new Set();
  }

  try {
    const url = `${config.supabaseUrl}/rest/v1/permits?select=id,nonce,beneficiary,amount,owner`;
    const res = await fetch(url, {
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
      },
    });

    if (!res.ok) {
      console.error(`Supabase error ${res.status}: ${await res.text()}`);
      return new Set();
    }

    const records: DatabasePermit[] = await res.json();
    const keys = new Set<string>();
    for (const rec of records) {
      keys.add(`${rec.nonce}:${rec.beneficiary.toLowerCase()}`);
    }
    console.log(`Found ${records.length} existing permits in database`);
    return keys;
  } catch (err) {
    console.error("Failed to fetch database permits:", err);
    return new Set();
  }
}

/**
 * Build reconciliation entries by de-duplicating scraped permits against the DB.
 */
export async function deduplicatePermits(
  permits: Permit[],
  config: BackfillConfig
): Promise<ReconciliationEntry[]> {
  const dbKeys = await fetchDatabasePermits(config);
  const entries: ReconciliationEntry[] = [];

  for (const permit of permits) {
    const key = `${permit.nonce}:${permit.beneficiary.toLowerCase()}`;
    const existsInDatabase = dbKeys.has(key);

    entries.push({
      permit,
      existsInDatabase,
      notes: existsInDatabase ? "Already exists in production database" : undefined,
    });
  }

  const newCount = entries.filter((e) => !e.existsInDatabase).length;
  console.log(`Deduplication complete: ${entries.length} scraped, ${entries.length - newCount} already in DB, ${newCount} new`);
  return entries;
}

/**
 * Merge validation results into reconciliation entries.
 */
export function mergeValidationResults(
  entries: ReconciliationEntry[],
  validations: ValidationResult[]
): ReconciliationEntry[] {
  const validationMap = new Map<string, ValidationResult>();
  for (const v of validations) {
    validationMap.set(v.permitId, v);
  }

  return entries.map((entry) => ({
    ...entry,
    validation: validationMap.get(entry.permit.id),
  }));
}

/**
 * Compute summary statistics from reconciliation entries.
 */
function computeSummary(entries: ReconciliationEntry[]): ReconciliationSummary {
  const newEntries = entries.filter((e) => !e.existsInDatabase);
  const byContributor: Record<string, { totalAmount: string; permitCount: number }> = {};
  const byRepository: Record<string, number> = {};

  let claimed = 0;
  let withdrawn = 0;
  let assumedWithdrawn = 0;
  let unresolved = 0;

  for (const entry of newEntries) {
    // Contributor breakdown
    const addr = entry.permit.beneficiary.toLowerCase();
    if (!byContributor[addr]) {
      byContributor[addr] = { totalAmount: "0", permitCount: 0 };
    }
    byContributor[addr].totalAmount = (
      BigInt(byContributor[addr].totalAmount) + BigInt(entry.permit.amount)
    ).toString();
    byContributor[addr].permitCount++;

    // Repository breakdown
    const repo = entry.permit.repository;
    byRepository[repo] = (byRepository[repo] ?? 0) + 1;

    // Status counts
    if (entry.validation) {
      switch (entry.validation.status) {
        case "claimed": claimed++; break;
        case "withdrawn": withdrawn++; break;
        case "assumed-withdrawn": assumedWithdrawn++; break;
        case "unresolved": unresolved++; break;
      }
    } else {
      unresolved++;
    }
  }

  return {
    totalPermitsScraped: entries.length,
    alreadyInDatabase: entries.length - newEntries.length,
    newPermits: newEntries.length,
    claimed,
    withdrawn,
    assumedWithdrawn,
    unresolved,
    byContributor,
    byRepository,
  };
}

/**
 * Produce the final reconciliation report.
 */
export function generateReport(entries: ReconciliationEntry[]): ReconciliationReport {
  const summary = computeSummary(entries);
  const unmatched = entries
    .filter((e) => !e.existsInDatabase && (!e.validation || e.validation.status === "unresolved"))
    .map((e) => e.permit);

  return {
    generatedAt: new Date().toISOString(),
    summary,
    entries,
    unmatchedForManualReview: unmatched,
  };
}

/**
 * Write the reconciliation report to disk.
 */
export async function writeReport(report: ReconciliationReport, outputDir: string): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Full JSON report
  const jsonPath = path.join(outputDir, `reconciliation-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // Human-readable summary
  const mdPath = path.join(outputDir, `reconciliation-${timestamp}.md`);
  const md = formatMarkdownReport(report);
  fs.writeFileSync(mdPath, md);

  console.log(`Report written to ${jsonPath} and ${mdPath}`);
  return jsonPath;
}

/** Format the report as a readable Markdown document. */
function formatMarkdownReport(report: ReconciliationReport): string {
  const { summary } = report;
  const lines: string[] = [
    `# Permit Reconciliation Report`,
    ``,
    `Generated: ${report.generatedAt}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Total scraped | ${summary.totalPermitsScraped} |`,
    `| Already in DB | ${summary.alreadyInDatabase} |`,
    `| New permits | ${summary.newPermits} |`,
    `| Claimed | ${summary.claimed} |`,
    `| Withdrawn | ${summary.withdrawn} |`,
    `| Assumed withdrawn | ${summary.assumedWithdrawn} |`,
    `| Unresolved | ${summary.unresolved} |`,
    ``,
    `## By Repository`,
    ``,
  ];

  const sortedRepos = Object.entries(summary.byRepository).sort((a, b) => b[1] - a[1]);
  for (const [repo, count] of sortedRepos) {
    lines.push(`- **${repo}**: ${count} permits`);
  }

  lines.push("", "## By Contributor", "");
  const sortedContributors = Object.entries(summary.byContributor).sort((a, b) => b[1].permitCount - a[1].permitCount);
  for (const [addr, data] of sortedContributors) {
    lines.push(`- \`${addr}\`: ${data.permitCount} permits, total ${data.totalAmount} wei`);
  }

  if (report.unmatchedForManualReview.length > 0) {
    lines.push("", "## Unmatched Permits (Manual Review Required)", "");
    for (const permit of report.unmatchedForManualReview) {
      lines.push(`- **${permit.id}** — ${permit.issueUrl} (${permit.network}, ${permit.source})`);
    }
  }

  return lines.join("\n");
}
