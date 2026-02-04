/**
 * Solana Backend Services
 * Handles Meteora SDK integration, transaction simulation, and transaction submission
 *
 * V3: Removed Jito bundles, using sequential submission with exponential backoff
 */
import { Connection } from '@solana/web3.js';
import { z } from 'zod';
declare const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=0d4b4fd6-c2fc-4f55-b615-a23bab1ffc85";
declare const connection: Connection;
declare const PROOF_V3_MINT = "CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av";
export declare const quoteInputSchema: z.ZodObject<{
    inputMint: z.ZodString;
    outputMint: z.ZodString;
    amount: z.ZodString;
    slippageBps: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    slippageBps: number;
    amount: string;
    inputMint: string;
    outputMint: string;
}, {
    amount: string;
    inputMint: string;
    outputMint: string;
    slippageBps?: number | undefined;
}>;
export declare const simulateInputSchema: z.ZodObject<{
    serializedTransaction: z.ZodString;
    isVersioned: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    serializedTransaction: string;
    isVersioned: boolean;
}, {
    serializedTransaction: string;
    isVersioned?: boolean | undefined;
}>;
export declare const submitBundleInputSchema: z.ZodObject<{
    signedTransactions: z.ZodArray<z.ZodString, "many">;
    useJito: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    useNonce: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    signedTransactions: string[];
    useJito: boolean;
    useNonce: boolean;
}, {
    signedTransactions: string[];
    useJito?: boolean | undefined;
    useNonce?: boolean | undefined;
}>;
export declare const createNonceAccountsInputSchema: z.ZodObject<{
    payerPublicKey: z.ZodString;
    count: z.ZodNumber;
    authorityPublicKey: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    payerPublicKey: string;
    count: number;
    authorityPublicKey?: string | undefined;
}, {
    payerPublicKey: string;
    count: number;
    authorityPublicKey?: string | undefined;
}>;
/**
 * Get Jupiter quote for a swap
 * Returns { success: true, quote } or { success: false, error }
 */
export declare function getJupiterQuote(input: z.infer<typeof quoteInputSchema>): Promise<{
    success: boolean;
    quote?: unknown;
    error?: string;
}>;
/**
 * Get fee swap transaction (input token -> PROOF V3)
 * This is used to buy PROOF tokens before burning them as a fee
 */
export declare function getFeeSwapTransaction(inputMint: string, amount: string, userPublicKey: string): Promise<{
    swapTransaction: null;
    error: string;
    lastValidBlockHeight?: undefined;
} | {
    swapTransaction: string | null;
    lastValidBlockHeight: number | null;
    error: null;
}>;
/**
 * Get Jupiter swap transaction
 * Returns { success: true, transaction } or { success: false, error }
 */
export declare function getJupiterSwapTransaction(quoteResponse: unknown, userPublicKey: string): Promise<{
    success: boolean;
    transaction?: string;
    error?: string;
}>;
/**
 * Simulate a transaction and return detailed results
 */
export declare function simulateTransaction(input: z.infer<typeof simulateInputSchema>): Promise<{
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
}>;
/**
 * Build transaction to create nonce accounts
 */
export declare function buildCreateNonceAccounts(input: z.infer<typeof createNonceAccountsInputSchema>): Promise<{
    rentPerNonce: number;
    totalRent: number;
    transaction: string;
    nonceKeypairs: string[];
    noncePublicKeys: string[];
}>;
/**
 * Submit transactions sequentially with exponential backoff
 * This replaces the old Jito bundle submission
 */
export declare function submitJitoBundle(input: z.infer<typeof submitBundleInputSchema>): Promise<{
    success: boolean;
    bundleId: string | null;
    signature: string | null;
    signatures: string[];
    error: string | null;
    usedFallback: boolean;
}>;
/**
 * Get transaction status using Solana RPC connection.getSignatureStatuses
 * @param bundleId - Can be a transaction signature (base58) to check status
 */
export declare function getBundleStatus(bundleId: string): Promise<{
    status: 'pending' | 'landed' | 'failed' | 'unknown';
    slot: number | null;
    error: string | null;
}>;
/**
 * Get a random tip account (legacy - kept for compatibility)
 */
export declare function getRandomTipAccount(): string;
/**
 * Check if a Meteora DAMM V2 pool exists for a token pair
 */
export declare function checkMeteoraPoolExists(tokenA: string, tokenB: string): Promise<{
    exists: boolean;
    poolAddress: string | null;
}>;
/**
 * Get token metadata from Helius
 */
export declare function getTokenMetadata(mint: string): Promise<{
    mint: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI: string | null;
} | null>;
export { connection, HELIUS_RPC_URL, PROOF_V3_MINT };
//# sourceMappingURL=solana.d.ts.map