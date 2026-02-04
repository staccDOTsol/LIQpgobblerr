/**
 * Nonce Account Manager
 *
 * Handles creation and management of durable nonce accounts for reliable transaction execution.
 * Nonce accounts allow transactions to be valid indefinitely (no blockhash expiration).
 *
 * Flow:
 * 1. User creates nonce accounts upfront (one per transaction in sequence)
 * 2. Transactions are built using nonce instead of recentBlockhash
 * 3. Server broadcasts with exponential backoff until confirmed
 * 4. After each tx confirms, advance the nonce for the next tx
 */
import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
declare const connection: Connection;
declare const NONCE_RENT_LAMPORTS = 1447680;
/**
 * Build instructions to create a nonce account
 * Returns the instructions and the nonce keypair
 */
export declare function buildCreateNonceAccountInstructions(payer: PublicKey, nonceKeypair: Keypair, authority: PublicKey): TransactionInstruction[];
/**
 * Build a transaction to create multiple nonce accounts
 * User signs this once to create all nonces needed for the swap sequence
 */
export declare function buildCreateNonceAccountsTransaction(payer: PublicKey, count: number, authority: PublicKey): Promise<{
    transaction: string;
    nonceKeypairs: string[];
    noncePublicKeys: string[];
}>;
/**
 * Get the current nonce value from a nonce account
 */
export declare function getNonceValue(nonceAccountPubkey: PublicKey): Promise<string | null>;
/**
 * Build an advance nonce instruction
 * This must be the FIRST instruction in any transaction using a nonce
 */
export declare function buildAdvanceNonceInstruction(noncePubkey: PublicKey, authorizedPubkey: PublicKey): TransactionInstruction;
/**
 * Prepend nonce advance instruction to an existing transaction
 * Replaces the blockhash with the nonce value
 */
export declare function convertToNonceTransaction(transaction: VersionedTransaction, nonceAccountPubkey: PublicKey, nonceAuthority: PublicKey): Promise<VersionedTransaction | null>;
/**
 * Build a transaction that uses a nonce account instead of blockhash
 * The nonce advance instruction is automatically prepended
 */
export declare function buildNonceTransaction(payer: PublicKey, instructions: TransactionInstruction[], nonceAccountPubkey: PublicKey, nonceAuthority: PublicKey): Promise<VersionedTransaction | null>;
/**
 * Submit a transaction with exponential backoff until confirmed
 * Works with both regular and nonce transactions
 */
export declare function submitWithExponentialBackoff(signedTransaction: Buffer, maxRetries?: number, initialDelayMs?: number, maxDelayMs?: number): Promise<{
    success: boolean;
    signature: string | null;
    error: string | null;
    attempts: number;
}>;
/**
 * Submit multiple transactions sequentially with exponential backoff
 * Each transaction must confirm before the next is submitted
 */
export declare function submitSequentialTransactions(signedTransactions: string[], // base64 encoded
onProgress?: (index: number, total: number, status: 'pending' | 'confirmed' | 'failed', signature?: string) => void): Promise<{
    success: boolean;
    signatures: string[];
    failedIndex: number | null;
    error: string | null;
}>;
export { connection, NONCE_RENT_LAMPORTS };
//# sourceMappingURL=nonce.d.ts.map