/**
 * GitHub scraper: recovers historical permit data from issues and comments
 * across Ubiquity-owned organizations and repositories.
 *
 * Sources:
 *  - UbiquityOS bot comments (prod & dev) containing base64-encoded permit URLs
 *  - Manual permit URLs from @0x4007 and @gentlementlegen
 */
import type { Permit, DecodedPermitPayload, BackfillConfig } from "./types";

const UBIQUITYOS_BOT_USERNAMES = ["ubiquity-os-bot", "ubiquity-os[bot]", "ubiquityos-dev", "ubiquity-os-dev[bot]"];
const MANUAL_SENDER_USERNAMES = ["0x4007", "gentlementlegen"];

/** Regex to find base64-encoded claim URLs in comment bodies. */
const CLAIM_URL_PATTERN = /https?:\/\/[^\s)"'<>]*\/claim\?claim=([A-Za-z0-9+/=]+)/g;
/** Alternative: raw base64 blobs near "permit"/"claim" keywords. */
const BASE64_BLOB_PATTERN = /(?:claim|permit|payload)[=:\s]+([A-Za-z0-9+/={40,}])/gi;

interface CommentData {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
}

/** Paginate through GitHub API results. */
async function* paginateGitHub<T>(url: string, token: string): AsyncGenerator<T[], void, unknown> {
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      console.error(`GitHub API error ${res.status} for ${url}: ${await res.text()}`);
      return;
    }
    const data: T[] = await res.json();
    if (data.length === 0) {
      hasMore = false;
    } else {
      yield data;
      hasMore = data.length === 100;
      page++;
    }
  }
}

/** List all repositories in an organization. */
async function listOrgRepos(org: string, token: string): Promise<string[]> {
  const repos: string[] = [];
  for await (const page of paginateGitHub<{ full_name: string }>(`https://api.github.com/orgs/${org}/repos?type=all&sort=updated`, token)) {
    repos.push(...page.map((r) => r.full_name));
  }
  return repos;
}

/** List all open + closed issues for a repository. */
async function listRepoIssues(owner: string, repo: string, token: string): Promise<number[]> {
  const issueNumbers: number[] = [];
  for (const state of ["open", "closed"]) {
    for await (const page of paginateGitHub<{ number: number }>(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}`,
      token
    )) {
      issueNumbers.push(...page.map((i) => i.number));
    }
  }
  return issueNumbers;
}

/** Fetch comments for a specific issue. */
async function getIssueComments(owner: string, repo: string, issueNumber: number, token: string): Promise<CommentData[]> {
  const comments: CommentData[] = [];
  for await (const page of paginateGitHub<CommentData>(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    token
  )) {
    comments.push(...page);
  }
  return comments;
}

/** Decode a base64 payload into a permit object. */
function decodePermitPayload(base64: string): DecodedPermitPayload | null {
  try {
    const decoded = Buffer.from(base64, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as DecodedPermitPayload;
    if (parsed.owner && parsed.beneficiary && parsed.nonce) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Determine the source of a permit based on comment author. */
function classifySource(login: string): Permit["source"] {
  const lower = login.toLowerCase();
  if (UBIQUITYOS_BOT_USERNAMES.some((b) => lower.includes(b.replace("[bot]", "").toLowerCase()))) {
    return "ubiquityos-bot";
  }
  if (lower === "0x4007") return "manual-0x4007";
  if (lower === "gentlementlegen") return "manual-gentlementlegen";
  return "unknown";
}

/** Determine the likely network from the payload or context. */
function inferNetwork(payload: DecodedPermitPayload): "ethereum" | "gnosis" {
  if (payload.network === "ethereum" || payload.network === "1") return "ethereum";
  if (payload.network === "gnosis" || payload.network === "100" || payload.network === "xdai") return "gnosis";
  // Default to gnosis for historical permits as most Ubiquity payouts were on Gnosis
  return "gnosis";
}

/** Build a Permit object from decoded payload and metadata. */
function buildPermit(
  payload: DecodedPermitPayload,
  issueUrl: string,
  repository: string,
  source: Permit["source"],
  commentCreatedAt: string,
  rawPayload: string
): Permit {
  return {
    id: `${payload.nonce}-${payload.beneficiary}`,
    issueUrl,
    repository,
    beneficiary: payload.beneficiary,
    owner: payload.owner,
    nonce: payload.nonce,
    amount: payload.amount ?? "0",
    tokenAddress: payload.tokenAddress ?? "0x0000000000000000000000000000000000000000",
    deadline: payload.deadline ?? 0,
    signature: payload.signature,
    username: undefined,
    network: inferNetwork(payload),
    source,
    rawPayload,
    commentCreatedAt,
  };
}

/** Extract permits from a single comment. */
function extractPermitsFromComment(
  comment: CommentData,
  owner: string,
  repo: string,
  issueNumber: number
): Permit[] {
  const permits: Permit[] = [];
  const login = comment.user?.login ?? "unknown";
  const issueUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;

  const isRelevant =
    UBIQUITYOS_BOT_USERNAMES.some((b) => login.toLowerCase().includes(b.replace("[bot]", "").toLowerCase())) ||
    MANUAL_SENDER_USERNAMES.includes(login.toLowerCase());

  if (!isRelevant) return permits;

  const source = classifySource(login);
  const seenNonces = new Set<string>();

  // Try claim URL pattern first
  let match: RegExpExecArray | null;
  CLAIM_URL_PATTERN.lastIndex = 0;
  while ((match = CLAIM_URL_PATTERN.exec(comment.body)) !== null) {
    const payload = decodePermitPayload(match[1]);
    if (payload && !seenNonces.has(payload.nonce)) {
      seenNonces.add(payload.nonce);
      permits.push(buildPermit(payload, issueUrl, `${owner}/${repo}`, source, comment.created_at, match[1]));
    }
  }

  // Try raw base64 blob pattern
  BASE64_BLOB_PATTERN.lastIndex = 0;
  while ((match = BASE64_BLOB_PATTERN.exec(comment.body)) !== null) {
    const payload = decodePermitPayload(match[1]);
    if (payload && !seenNonces.has(payload.nonce)) {
      seenNonces.add(payload.nonce);
      permits.push(buildPermit(payload, issueUrl, `${owner}/${repo}`, source, comment.created_at, match[1]));
    }
  }

  return permits;
}

/**
 * Main scraping entry point. Enumerates orgs/repos and extracts all permits.
 */
export async function scrapePermits(config: BackfillConfig): Promise<Permit[]> {
  const allPermits: Permit[] = [];
  const seenIds = new Set<string>();

  // Resolve repo list
  let repos: string[];
  if (config.repositories && config.repositories.length > 0) {
    repos = config.repositories;
  } else {
    repos = [];
    for (const org of config.organizations) {
      const orgRepos = await listOrgRepos(org, config.githubToken);
      repos.push(...orgRepos);
      console.log(`Found ${orgRepos.length} repos in org ${org}`);
    }
  }

  console.log(`Scanning ${repos.length} repositories for permits...`);

  for (const repoFullName of repos) {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) continue;

    console.log(`Scanning ${repoFullName}...`);
    const issueNumbers = await listRepoIssues(owner, repo, config.githubToken);
    console.log(`  Found ${issueNumbers.length} issues`);

    for (const issueNumber of issueNumbers) {
      const comments = await getIssueComments(owner, repo, issueNumber, config.githubToken);
      for (const comment of comments) {
        const permits = extractPermitsFromComment(comment, owner, repo, issueNumber);
        for (const permit of permits) {
          if (!seenIds.has(permit.id)) {
            seenIds.add(permit.id);
            allPermits.push(permit);
          }
        }
      }
    }
  }

  console.log(`Total unique permits scraped: ${allPermits.length}`);
  return allPermits;
}
