/**
 * Atomic LP Transaction Builder
 *
 * Bundles Create Position + Add Liquidity + Lock + NFT Transfer into a single transaction
 * so everything happens atomically or fails together.
 *
 * IMPORTANT: The position NFT is minted to the positionNftAccount PDA (derived from the NFT mint).
 * The wallet that creates the position has authority over this PDA token account.
 * To transfer the NFT, we transfer FROM the positionNftAccount PDA to the recipient's ATA.
 */
import { Keypair } from '@solana/web3.js';
interface AtomicLPResult {
    success: boolean;
    transaction: string | null;
    positionAddress: string | null;
    positionNftMint: string | null;
    error: string | null;
}
/**
 * Build a single atomic transaction that:
 * 1. Creates position (mints NFT to owner's ATA)
 * 2. Adds liquidity
 * 3. Locks the position permanently
 * 4. Transfers the NFT from owner's ATA to recipient's ATA
 *
 * The key insight is that after createPosition, the NFT is in the OWNER's ATA
 * (derived from positionNftMint + owner), NOT in the positionNftAccount PDA.
 * The positionNftAccount is a program-derived account used for position tracking.
 */
export declare function buildAtomicLPTransaction(poolAddress: string, tokenAMint: string, tokenBMint: string, tokenAAmount: string, tokenBAmount: string, systemWallet: Keypair, recipientAddress: string, slippageBps?: number): Promise<AtomicLPResult>;
/**
 * Submit the atomic transaction to the network with retry logic
 */
export declare function submitAtomicTransaction(serializedTx: string): Promise<{
    success: boolean;
    signature: string | null;
    error: string | null;
}>;
/**
 * Build a single atomic transaction for creating a NEW pool that:
 * 1. Creates pool with initial liquidity (with lock option)
 * 2. Transfers the NFT to recipient
 *
 * This is used when no pool exists for the token pair.
 */
export declare function buildAtomicPoolCreationTransaction(tokenAMint: string, tokenBMint: string, tokenAAmount: string, tokenBAmount: string, systemWallet: Keypair, recipientAddress: string): Promise<AtomicLPResult & {
    poolAddress: string | null;
}>;
export {};
//# sourceMappingURL=meteora-atomic.d.ts.map