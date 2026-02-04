/**
 * Solana Backend Services
 * Handles Meteora SDK integration, transaction simulation, and transaction submission
 * 
 * V3: Removed Jito bundles, using sequential submission with exponential backoff
 */

import { Connection, PublicKey, Transaction, VersionedTransaction, SimulatedTransactionResponse } from '@solana/web3.js';
import { z } from 'zod';
import bs58 from 'bs58';
import {
  submitSequentialTransactions,
  submitWithExponentialBackoff,
  buildCreateNonceAccountsTransaction,
  getNonceValue,
  NONCE_RENT_LAMPORTS,
} from './nonce.js';

// Helius RPC endpoint
const HELIUS_API_KEY = '0d4b4fd6-c2fc-4f55-b615-a23bab1ffc85';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const connection = new Connection(HELIUS_RPC_URL, 'confirmed');

// Jupiter API - Official API with API key for higher rate limits
const JUPITER_API_KEY = '6c006183-e55a-47cd-90b7-bd9b3f206a1a';
const JUPITER_API_URL = 'https://api.jup.ag/swap/v1';
const JUPITER_HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': JUPITER_API_KEY,
};

// PROOF V3 Token for fee burn
const PROOF_V3_MINT = 'CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av';

// Input validation schemas
export const quoteInputSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  amount: z.string(),
  slippageBps: z.number().optional().default(50),
});

export const simulateInputSchema = z.object({
  serializedTransaction: z.string(), // Base64 encoded transaction
  isVersioned: z.boolean().optional().default(true),
});

export const submitBundleInputSchema = z.object({
  signedTransactions: z.array(z.string()), // Array of base64 encoded signed transactions
  useJito: z.boolean().optional().default(false), // Deprecated - Jito is no longer used
  useNonce: z.boolean().optional().default(false), // Whether transactions use nonce accounts
});

export const createNonceAccountsInputSchema = z.object({
  payerPublicKey: z.string(),
  count: z.number().min(1).max(10),
  authorityPublicKey: z.string().optional(), // Defaults to payer
});

/**
 * Get Jupiter quote for a swap
 * Returns { success: true, quote } or { success: false, error }
 */
export async function getJupiterQuote(input: z.infer<typeof quoteInputSchema>): Promise<{
  success: boolean;
  quote?: any;
  error?: string;
}> {
  try {
    const { inputMint, outputMint, amount, slippageBps } = input;
    
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount,
      slippageBps: slippageBps.toString(),
    });

    const response = await fetch(`${JUPITER_API_URL}/quote?${params}`, {
      headers: JUPITER_HEADERS,
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('[Jupiter] Quote failed:', error);
      return { success: false, error: `Jupiter quote failed: ${error}` };
    }

    const quote = await response.json();
    
    // Check if quote has required fields
    if (!quote || !quote.outAmount) {
      return { success: false, error: 'Invalid quote response from Jupiter' };
    }
    
    return { success: true, quote };
  } catch (error) {
    console.error('[Jupiter] Quote error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Get fee swap transaction (input token -> PROOF V3)
 * This is used to buy PROOF tokens before burning them as a fee
 */
export async function getFeeSwapTransaction(inputMint: string, amount: string, userPublicKey: string) {
  // First get a quote for the fee swap
  const quoteParams = new URLSearchParams({
    inputMint,
    outputMint: PROOF_V3_MINT,
    amount,
    slippageBps: '1500', // 15% slippage for fee swap (high tolerance since it's a small fee amount)
  });

  const quoteResponse = await fetch(`${JUPITER_API_URL}/quote?${quoteParams}`, {
    headers: JUPITER_HEADERS,
  });
  
  if (!quoteResponse.ok) {
    const error = await quoteResponse.text();
    console.error('Fee swap quote failed:', error);
    return { swapTransaction: null, error: `Quote failed: ${error}` };
  }

  const quote = await quoteResponse.json();
  console.log('Fee swap quote:', JSON.stringify(quote).slice(0, 200));

  // Now get the swap transaction
  const swapResponse = await fetch(`${JUPITER_API_URL}/swap`, {
    method: 'POST',
    headers: JUPITER_HEADERS,
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
      asLegacyTransaction: false,
      skipSimulation: true,
    }),
  });

  if (!swapResponse.ok) {
    const error = await swapResponse.text();
    console.error('Fee swap transaction failed:', error);
    return { swapTransaction: null, error: `Swap failed: ${error}` };
  }

  const result = await swapResponse.json();
  
  if (result.simulationError) {
    console.warn('Fee swap simulation warning:', JSON.stringify(result.simulationError));
  }
  
  return {
    swapTransaction: result.swapTransaction,
    lastValidBlockHeight: result.lastValidBlockHeight,
    error: null,
  };
}

/**
 * Get Jupiter swap transaction
 * Returns { success: true, transaction } or { success: false, error }
 */
export async function getJupiterSwapTransaction(quoteResponse: any, userPublicKey: string): Promise<{
  success: boolean;
  transaction?: string;
  error?: string;
}> {
  try {
    const response = await fetch(`${JUPITER_API_URL}/swap`, {
      method: 'POST',
      headers: JUPITER_HEADERS,
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
        asLegacyTransaction: false, // Use versioned transactions
        skipSimulation: true, // Skip Jupiter's simulation - we'll handle errors on-chain
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Jupiter] Swap failed:', error);
      return { success: false, error: `Jupiter swap failed: ${error}` };
    }

    const result = await response.json();
    
    // Log simulation error but don't fail - let the transaction try on-chain
    if (result.simulationError) {
      console.warn('[Jupiter] Simulation warning:', JSON.stringify(result.simulationError));
    }
    
    if (!result.swapTransaction) {
      return { success: false, error: 'No swap transaction returned from Jupiter' };
    }
    
    return { success: true, transaction: result.swapTransaction };
  } catch (error) {
    console.error('[Jupiter] Swap error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Simulate a transaction and return detailed results
 */
export async function simulateTransaction(input: z.infer<typeof simulateInputSchema>): Promise<{
  success: boolean;
  logs: string[];
  unitsConsumed: number | null;
  error: string | null;
  balanceChanges: Array<{
    account: string;
    before: number;
    after: number;
    change: number;
  }>;
}> {
  const { serializedTransaction, isVersioned } = input;
  
  try {
    const txBuffer = Buffer.from(serializedTransaction, 'base64');
    
    let simulation: SimulatedTransactionResponse;
    
    if (isVersioned) {
      const tx = VersionedTransaction.deserialize(txBuffer);
      const result = await connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      simulation = result.value;
    } else {
      const tx = Transaction.from(txBuffer);
      const result = await connection.simulateTransaction(tx);
      simulation = result.value;
    }

    return {
      success: simulation.err === null,
      logs: simulation.logs || [],
      unitsConsumed: simulation.unitsConsumed || null,
      error: simulation.err ? JSON.stringify(simulation.err) : null,
      balanceChanges: [], // Would need to parse logs for detailed changes
    };
  } catch (error) {
    return {
      success: false,
      logs: [],
      unitsConsumed: null,
      error: error instanceof Error ? error.message : 'Unknown simulation error',
      balanceChanges: [],
    };
  }
}

/**
 * Build transaction to create nonce accounts
 */
export async function buildCreateNonceAccounts(input: z.infer<typeof createNonceAccountsInputSchema>) {
  const { payerPublicKey, count, authorityPublicKey } = input;
  
  const payer = new PublicKey(payerPublicKey);
  const authority = authorityPublicKey ? new PublicKey(authorityPublicKey) : payer;
  
  const result = await buildCreateNonceAccountsTransaction(payer, count, authority);
  
  return {
    ...result,
    rentPerNonce: NONCE_RENT_LAMPORTS,
    totalRent: NONCE_RENT_LAMPORTS * count,
  };
}

/**
 * Submit transactions sequentially with exponential backoff
 * This replaces the old Jito bundle submission
 */
export async function submitJitoBundle(input: z.infer<typeof submitBundleInputSchema>): Promise<{
  success: boolean;
  bundleId: string | null;
  signature: string | null;
  signatures: string[];
  error: string | null;
  usedFallback: boolean;
}> {
  const { signedTransactions } = input;
  
  console.log('=== submitJitoBundle called (V3 - Sequential with Exponential Backoff) ===');
  console.log('Number of transactions to submit:', signedTransactions.length);
  
  // Submit all transactions sequentially with exponential backoff
  const result = await submitSequentialTransactions(signedTransactions, (index, total, status, sig) => {
    console.log(`Progress: TX ${index + 1}/${total} - ${status}${sig ? ` (${sig.slice(0, 20)}...)` : ''}`);
  });
  
  if (result.success) {
    console.log('All transactions confirmed!');
    console.log('Signatures:', result.signatures);
    
    // Return the main swap signature (usually the 2nd or 3rd transaction)
    const mainSignature = result.signatures.length > 1 
      ? result.signatures[Math.min(2, result.signatures.length - 1)]
      : result.signatures[0];
    
    return {
      success: true,
      bundleId: null,
      signature: mainSignature || null,
      signatures: result.signatures,
      error: null,
      usedFallback: true, // Always true now since we don't use Jito
    };
  } else {
    console.error('Transaction sequence failed at index:', result.failedIndex);
    console.error('Error:', result.error);
    
    return {
      success: false,
      bundleId: null,
      signature: result.signatures[0] || null,
      signatures: result.signatures,
      error: result.error,
      usedFallback: true,
    };
  }
}

/**
 * Get transaction status using Solana RPC connection.getSignatureStatuses
 * @param bundleId - Can be a transaction signature (base58) to check status
 */
export async function getBundleStatus(bundleId: string): Promise<{
  status: 'pending' | 'landed' | 'failed' | 'unknown';
  slot: number | null;
  error: string | null;
}> {
  try {
    // bundleId is actually a transaction signature - check it on-chain
    const result = await connection.getSignatureStatuses([bundleId], {
      searchTransactionHistory: true,
    });
    
    const status = result.value[0];
    
    if (!status) {
      // Transaction not found yet - still pending
      return {
        status: 'pending',
        slot: null,
        error: null,
      };
    }
    
    if (status.err) {
      // Transaction failed
      return {
        status: 'failed',
        slot: status.slot,
        error: JSON.stringify(status.err),
      };
    }
    
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      // Transaction landed successfully
      return {
        status: 'landed',
        slot: status.slot,
        error: null,
      };
    }
    
    // Still processing
    return {
      status: 'pending',
      slot: status.slot,
      error: null,
    };
  } catch (error) {
    console.error('Error checking transaction status:', error);
    return {
      status: 'unknown',
      slot: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get a random tip account (legacy - kept for compatibility)
 */
export function getRandomTipAccount(): string {
  const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4bVmkdzGtLVKTYg4aSNT2Cg',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  ];
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

/**
 * Check if a Meteora DAMM V2 pool exists for a token pair
 */
export async function checkMeteoraPoolExists(tokenA: string, tokenB: string): Promise<{
  exists: boolean;
  poolAddress: string | null;
}> {
  try {
    // Query Meteora API for existing pools
    const response = await fetch(`https://dlmm-api.meteora.ag/pair/all`);
    const pools = await response.json();
    
    // Search for a pool with the token pair
    const pool = pools.find((p: any) => 
      (p.mint_x === tokenA && p.mint_y === tokenB) ||
      (p.mint_x === tokenB && p.mint_y === tokenA)
    );

    return {
      exists: !!pool,
      poolAddress: pool?.address || null,
    };
  } catch (error) {
    console.error('Error checking Meteora pool:', error);
    return {
      exists: false,
      poolAddress: null,
    };
  }
}

/**
 * Get token metadata from Helius
 */
export async function getTokenMetadata(mint: string) {
  try {
    const response = await fetch(HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAsset',
        params: { id: mint },
      }),
    });

    const result = await response.json();
    
    if (result.error) {
      return null;
    }

    const asset = result.result;
    return {
      mint,
      name: asset.content?.metadata?.name || 'Unknown',
      symbol: asset.content?.metadata?.symbol || '???',
      decimals: asset.token_info?.decimals || 9,
      logoURI: asset.content?.links?.image || asset.content?.files?.[0]?.uri || null,
    };
  } catch (error) {
    console.error('Error fetching token metadata:', error);
    return null;
  }
}

export { connection, HELIUS_RPC_URL, PROOF_V3_MINT };
