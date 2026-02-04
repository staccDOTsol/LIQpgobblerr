/**
 * Meteora DAMM V2 Integration
 * Real implementation using @meteora-ag/cp-amm-sdk
 *
 * Flow:
 * 1. If pool doesn't exist: createPool (creates pool + initial position + liquidity in one tx)
 * 2. If pool exists but user has no position: createPosition, then addLiquidity
 * 3. If pool exists and user has position: addLiquidity directly
 * 4. If lockLiquidity is true: permanentLockPosition after adding liquidity
 *
 * IMPORTANT: Position NFTs use Token-2022 program, not regular SPL Token!
 */
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
export declare const METEORA_STANDARD_CONFIG: PublicKey;
export declare const findOrCreatePoolInputSchema: z.ZodObject<{
    tokenAMint: z.ZodString;
    tokenBMint: z.ZodString;
    userPublicKey: z.ZodString;
}, "strip", z.ZodTypeAny, {
    tokenAMint: string;
    tokenBMint: string;
    userPublicKey: string;
}, {
    tokenAMint: string;
    tokenBMint: string;
    userPublicKey: string;
}>;
export declare const addLiquidityInputSchema: z.ZodObject<{
    poolAddress: z.ZodString;
    tokenAMint: z.ZodString;
    tokenBMint: z.ZodString;
    tokenAAmount: z.ZodString;
    tokenBAmount: z.ZodString;
    userPublicKey: z.ZodString;
    slippageBps: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    poolAddress: string;
    tokenAMint: string;
    tokenBMint: string;
    userPublicKey: string;
    tokenAAmount: string;
    tokenBAmount: string;
    slippageBps: number;
}, {
    poolAddress: string;
    tokenAMint: string;
    tokenBMint: string;
    userPublicKey: string;
    tokenAAmount: string;
    tokenBAmount: string;
    slippageBps?: number | undefined;
}>;
export declare const createPoolAndAddLiquidityInputSchema: z.ZodObject<{
    tokenAMint: z.ZodString;
    tokenBMint: z.ZodString;
    tokenAAmount: z.ZodString;
    tokenBAmount: z.ZodString;
    userPublicKey: z.ZodString;
    initialPrice: z.ZodNumber;
    lockLiquidity: z.ZodDefault<z.ZodBoolean>;
    positionNftMint: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    tokenAMint: string;
    tokenBMint: string;
    userPublicKey: string;
    tokenAAmount: string;
    tokenBAmount: string;
    initialPrice: number;
    lockLiquidity: boolean;
    positionNftMint?: string | undefined;
}, {
    tokenAMint: string;
    tokenBMint: string;
    userPublicKey: string;
    tokenAAmount: string;
    tokenBAmount: string;
    initialPrice: number;
    positionNftMint?: string | undefined;
    lockLiquidity?: boolean | undefined;
}>;
export declare const lockPositionInputSchema: z.ZodObject<{
    poolAddress: z.ZodString;
    positionAddress: z.ZodString;
    positionLiquidity: z.ZodString;
    userPublicKey: z.ZodString;
}, "strip", z.ZodTypeAny, {
    poolAddress: string;
    positionAddress: string;
    userPublicKey: string;
    positionLiquidity: string;
}, {
    poolAddress: string;
    positionAddress: string;
    userPublicKey: string;
    positionLiquidity: string;
}>;
export declare function getCpAmm(): CpAmm;
export declare function warmupMeteoraSDK(): Promise<void>;
export declare function waitForSDKReady(timeoutMs?: number): Promise<boolean>;
/**
 * Get associated token address with correct program ID based on mint type
 */
export declare function getAssociatedTokenAddressForMint(mint: PublicKey, owner: PublicKey): Promise<{
    ata: PublicKey;
    tokenProgram: PublicKey;
}>;
/**
 * Create ATA instruction with correct program ID based on mint type
 */
export declare function createAtaInstructionForMint(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): import("@solana/web3.js").TransactionInstruction;
/**
 * Find existing pool for token pair using fetchPoolStatesByTokenAMint
 * This is more reliable than derivePoolAddress because it finds pools
 * regardless of which config they were created with
 */
export declare function findPool(tokenAMint: string, tokenBMint: string): Promise<{
    exists: boolean;
    poolAddress: string | null;
    poolState: any | null;
}>;
/**
 * Get deposit quote for adding liquidity
 */
export declare function getDepositQuote(poolAddress: string, tokenAAmount: string, isTokenA?: boolean): Promise<{
    tokenAAmount: string;
    tokenBAmount: string;
    liquidityDelta: string;
} | null>;
/**
 * Build transaction to create a new pool with initial liquidity
 * createPool() creates pool + initial position + adds liquidity in one transaction
 */
export declare function buildCreatePoolTransaction(input: z.infer<typeof createPoolAndAddLiquidityInputSchema>): Promise<{
    success: boolean;
    transaction: string | null;
    poolAddress: string | null;
    positionAddress: string | null;
    positionNftMint?: string;
    needsClientSigning: boolean;
    error: string | null;
}>;
/**
 * Build transactions to add liquidity to existing pool
 *
 * Flow:
 * 1. Check if user has existing position
 * 2. If no position: create position first, then add liquidity (2 transactions)
 * 3. If position exists: add liquidity directly (1 transaction)
 */
export declare function buildAddLiquidityTransaction(input: z.infer<typeof addLiquidityInputSchema>): Promise<{
    success: boolean;
    transactions: string[];
    positionAddress: string | null;
    positionNftMint?: string;
    liquidityDelta?: string;
    error: string | null;
}>;
/**
 * Build transaction to permanently lock LP position
 */
export declare function buildLockPositionTransaction(input: z.infer<typeof lockPositionInputSchema>): Promise<{
    success: boolean;
    transaction: string | null;
    error: string | null;
}>;
/**
 * Combined function: Find or create pool, add liquidity, optionally lock
 * Returns serialized transactions for the user to sign
 *
 * Flow:
 * 1. Check if pool exists
 * 2. If pool doesn't exist: use createPool (creates pool + position + liquidity in one tx)
 * 3. If pool exists: use buildAddLiquidityTransaction (handles position creation if needed)
 * 4. If lockLiquidity is true and pool already existed: add lock transaction
 */
export declare function buildLiquidityProvisioningTransactions(tokenAMint: string, tokenBMint: string, tokenAAmount: string, tokenBAmount: string, userPublicKey: string, lockLiquidity?: boolean, positionNftMintStr?: string): Promise<{
    success: boolean;
    transactions: string[];
    poolAddress: string | null;
    positionAddress: string | null;
    positionNftMint?: string;
    liquidityDelta?: string;
    isNewPool: boolean;
    error: string | null;
    needsPositionSigner: boolean;
}>;
//# sourceMappingURL=meteora-damm.d.ts.map