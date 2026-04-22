/**
 * On-chain validator: checks permit validity against Ethereum and Gnosis chains.
 *
 * For each permit:
 *  1. Check if the nonce has been invalidated (claimed or withdrawn).
 *  2. If claimed, find the claim transaction.
 *  3. If not claimed, check for invalidation by the owner (withdrawal).
 *  4. Otherwise classify as unresolved or assumed-withdrawn.
 */
import type { Permit, ValidationResult, BackfillConfig } from "./types";

/** JSON-RPC helper. */
async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message}`);
  }
  return json.result;
}

/** ERC20-style nonces(address) → uint256 call. Selector: 0x7ecebe00 */
const NONCES_SELECTOR = "0x7ecebe00";

/** Get the current nonce for an owner address from the permit contract. */
async function getCurrentNonce(rpcUrl: string, contractAddress: string, ownerAddress: string): Promise<bigint> {
  // Encode: nonces(address) with padded address param
  const paddedAddress = ownerAddress.toLowerCase().replace("0x", "").padStart(64, "0");
  const data = NONCES_SELECTOR + paddedAddress;
  const result = await rpcCall(rpcUrl, "eth_call", [{ to: contractAddress, data }, "latest"]);
  return BigInt(result as string);
}

/**
 * Query Etherscan/GnosisScan API for transactions from/to an address interacting
 * with the permit contract.
 */
async function findTransaction(
  explorerApiUrl: string,
  apiKey: string,
  address: string,
  contractAddress: string,
  startBlock: number
): Promise<{ txHash: string; blockNumber: number } | null> {
  const url = `${explorerApiUrl}?module=account&action=txlist&address=${address}&startblock=${startBlock}&endblock=99999999&sort=asc&apikey=${apiKey}`;
  try {
    const res = await fetch(url);
    const data = (await res.json()) as { status: string; result: Array<{ hash: string; blockNumber: string; to: string; from: string }> };
    if (data.status === "1" && Array.isArray(data.result)) {
      const match = data.result.find(
        (tx) => tx.to.toLowerCase() === contractAddress.toLowerCase()
      );
      if (match) {
        return { txHash: match.hash, blockNumber: parseInt(match.blockNumber, 10) };
      }
    }
  } catch (err) {
    console.error(`Explorer API error for ${address}:`, err);
  }
  return null;
}

/** Rough block number estimation from Unix timestamp. */
function estimateBlockFromTimestamp(timestamp: number, network: "ethereum" | "gnosis"): number {
  if (network === "ethereum") {
    return Math.floor(Math.max(0, timestamp - 1438269971) / 12);
  }
  return Math.floor(Math.max(0, timestamp - 1508131339) / 5);
}

/**
 * Validate a single permit against on-chain state.
 */
export async function validatePermit(permit: Permit, config: BackfillConfig): Promise<ValidationResult> {
  const rpcUrl = permit.network === "ethereum" ? (config.ethereumRpcUrl ?? "") : (config.gnosisRpcUrl ?? "");
  const contractAddress = permit.network === "ethereum" ? config.ethereumPermitContract : config.gnosisPermitContract;
  const explorerUrl = permit.network === "ethereum" ? "https://api.etherscan.io/api" : "https://api.gnosisscan.io/api";
  const explorerKey = permit.network === "ethereum" ? (config.etherscanApiKey ?? "") : (config.gnosisscanApiKey ?? "");

  if (!rpcUrl || !contractAddress) {
    return {
      permitId: permit.id,
      invalidated: false,
      status: "unresolved",
      network: permit.network,
      notes: "Missing RPC URL or contract address for validation",
    };
  }

  try {
    // Step 1: Check current nonce — if it's advanced past our nonce, it was consumed
    const currentNonce = await getCurrentNonce(rpcUrl, contractAddress, permit.owner);
    const permitNonce = BigInt(permit.nonce);

    if (currentNonce > permitNonce) {
      // Nonce consumed — try to find the claim tx from the beneficiary
      const startBlock = permit.deadline > 0 ? estimateBlockFromTimestamp(permit.deadline, permit.network) - 1000 : 0;
      const claimTx = await findTransaction(explorerUrl, explorerKey, permit.beneficiary, contractAddress, Math.max(0, startBlock));

      if (claimTx) {
        return {
          permitId: permit.id,
          invalidated: true,
          status: "claimed",
          txHash: claimTx.txHash,
          blockNumber: claimTx.blockNumber,
          network: permit.network,
        };
      }
      return {
        permitId: permit.id,
        invalidated: true,
        status: "claimed",
        network: permit.network,
        notes: "Nonce consumed on-chain but direct claim tx not matched",
      };
    }

    // Step 2: Nonce not consumed — check if owner invalidated it (withdrawal)
    const ownerTx = await findTransaction(explorerUrl, explorerKey, permit.owner, contractAddress, 0);
    if (ownerTx) {
      return {
        permitId: permit.id,
        invalidated: true,
        status: "withdrawn",
        txHash: ownerTx.txHash,
        blockNumber: ownerTx.blockNumber,
        network: permit.network,
      };
    }

    // Step 3: Not claimed, not explicitly withdrawn
    if (permit.deadline > 0 && permit.deadline < Math.floor(Date.now() / 1000)) {
      return {
        permitId: permit.id,
        invalidated: false,
        status: "assumed-withdrawn",
        network: permit.network,
      };
    }

    return {
      permitId: permit.id,
      invalidated: false,
      status: "unresolved",
      network: permit.network,
    };
  } catch (err) {
    console.error(`Validation error for permit ${permit.id}:`, err);
    return {
      permitId: permit.id,
      invalidated: false,
      status: "unresolved",
      network: permit.network,
      notes: `Validation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Batch validate all permits sequentially to avoid rate limits.
 */
export async function validateAllPermits(permits: Permit[], config: BackfillConfig): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  console.log(`Validating ${permits.length} permits on-chain...`);

  for (let i = 0; i < permits.length; i++) {
    const result = await validatePermit(permits[i], config);
    results.push(result);
    if ((i + 1) % 50 === 0) {
      console.log(`  Validated ${i + 1}/${permits.length}`);
    }
    // Small delay to respect rate limits
    if ((i + 1) % 5 === 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`Validation complete: ${results.length} permits processed`);
  return results;
}
