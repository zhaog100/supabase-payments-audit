/**
 * Core types for the historical permit backfill and validation system.
 */

/** Shape of a reconstructed permit from GitHub issues/comments. */
export interface Permit {
  /** Unique identifier for the permit (derived from nonce + beneficiary). */
  id: string;
  /** GitHub issue URL that originated the permit. */
  issueUrl: string;
  /** GitHub repository full name (owner/repo). */
  repository: string;
  /** Ethereum address of the beneficiary (payee). */
  beneficiary: string;
  /** Ethereum address of the signer/owner who issued the permit. */
  owner: string;
  /** Permit nonce used for on-chain invalidation checks. */
  nonce: string;
  /** Token amount in smallest unit (wei). */
  amount: string;
  /** Token address (zero address for native/ETH). */
  tokenAddress: string;
  /** Deadline timestamp (seconds). */
  deadline: number;
  /** Signature bytes (hex). */
  signature?: string;
  /** GitHub username of the beneficiary, parsed from comment context. */
  username?: string;
  /** Which network this permit targets. */
  network: "ethereum" | "gnosis";
  /** Source of the permit data. */
  source: "ubiquityos-bot" | "manual-0x4007" | "manual-gentlementlegen" | "unknown";
  /** Raw base64 payload (for debugging). */
  rawPayload?: string;
  /** ISO timestamp when the permit comment was created. */
  commentCreatedAt: string;
}

/** Result of on-chain validation for a single permit. */
export interface ValidationResult {
  permitId: string;
  /** Whether the permit nonce has been invalidated on-chain. */
  invalidated: boolean;
  /** How the permit was resolved. */
  status: "claimed" | "withdrawn" | "assumed-withdrawn" | "unresolved";
  /** Transaction hash of the claim or invalidation, if found. */
  txHash?: string;
  /** Block number of the relevant transaction. */
  blockNumber?: number;
  /** Network where validation was performed. */
  network: "ethereum" | "gnosis";
  /** Optional notes about validation edge cases. */
  notes?: string;
}

/** Entry in the reconciliation report. */
export interface ReconciliationEntry {
  permit: Permit;
  validation?: ValidationResult;
  /** Whether this permit already exists in the production database. */
  existsInDatabase: boolean;
  /** Notes / edge case descriptions. */
  notes?: string;
}

/** Summary statistics for the reconciliation report. */
export interface ReconciliationSummary {
  totalPermitsScraped: number;
  alreadyInDatabase: number;
  newPermits: number;
  claimed: number;
  withdrawn: number;
  assumedWithdrawn: number;
  unresolved: number;
  /** Per-contributor breakdown: beneficiary address → total amount + count. */
  byContributor: Record<string, { totalAmount: string; permitCount: number }>;
  /** Per-repository breakdown: repo → permit count. */
  byRepository: Record<string, number>;
}

/** Full reconciliation report output. */
export interface ReconciliationReport {
  generatedAt: string;
  summary: ReconciliationSummary;
  entries: ReconciliationEntry[];
  /** Permits that could not be matched and need manual review. */
  unmatchedForManualReview: Permit[];
}

/** Configuration for the backfill pipeline. */
export interface BackfillConfig {
  /** GitHub personal access token. */
  githubToken: string;
  /** GitHub organizations to scan. */
  organizations: string[];
  /** Specific repositories to include (optional whitelist). */
  repositories?: string[];
  /** Supabase URL for DB dedup. */
  supabaseUrl?: string;
  /** Supabase service key. */
  supabaseKey?: string;
  /** Ethereum RPC URL. */
  ethereumRpcUrl?: string;
  /** Gnosis RPC URL. */
  gnosisRpcUrl?: string;
  /** Etherscan API key. */
  etherscanApiKey?: string;
  /** GnosisScan API key. */
  gnosisscanApiKey?: string;
  /** Known Ubiquity funding wallet addresses. */
  knownFundingWallets: string[];
  /** Permit contract address on Ethereum. */
  ethereumPermitContract?: string;
  /** Permit contract address on Gnosis. */
  gnosisPermitContract?: string;
  /** Output directory for reports. */
  outputDir: string;
}

/** Decoded base64 permit payload shape (as found in UbiquityOS bot comments). */
export interface DecodedPermitPayload {
  owner: string;
  beneficiary: string;
  nonce: string;
  amount?: string;
  tokenAddress?: string;
  deadline?: number;
  signature?: string;
  network?: string;
  [key: string]: unknown;
}

/** Database permit record for dedup comparison. */
export interface DatabasePermit {
  id: string;
  nonce: string;
  beneficiary: string;
  amount: string;
  owner: string;
  issueUrl?: string;
}
