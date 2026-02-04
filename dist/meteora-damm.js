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
import { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID, } from '@solana/spl-token';
import { z } from 'zod';
import BN from 'bn.js';
// Import Meteora SDK
import { CpAmm, getSqrtPriceFromPrice, derivePoolAddress, derivePositionAddress, derivePositionNftAccount } from '@meteora-ag/cp-amm-sdk';
// Helius RPC endpoint - use environment variable if available
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '0d4b4fd6-c2fc-4f55-b615-a23bab1ffc85';
const HELIUS_RPC_URL = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const connection = new Connection(HELIUS_RPC_URL, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 30000, // 30 second timeout
});
console.log('[METEORA] Using RPC URL:', HELIUS_RPC_URL.substring(0, 50) + '...');
// Timeout helper for async operations
function withTimeout(promise, timeoutMs, operation) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs))
    ]);
}
// Meteora DAMM V2 Program ID
const DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
// Meteora DAMM V2 config - permissionless config (poolCreatorAuthority = system program)
// Found via cpAmm.getAllConfigs() - this is a valid DAMM V2 config owned by the DAMM V2 program
export const METEORA_STANDARD_CONFIG = new PublicKey('TBuzuEMMQizTjpZhRLaUPavALhZmD8U1hwiw1pWSCSq');
// Input schemas
export const findOrCreatePoolInputSchema = z.object({
    tokenAMint: z.string(),
    tokenBMint: z.string(),
    userPublicKey: z.string(),
});
export const addLiquidityInputSchema = z.object({
    poolAddress: z.string(),
    tokenAMint: z.string(),
    tokenBMint: z.string(),
    tokenAAmount: z.string(),
    tokenBAmount: z.string(),
    userPublicKey: z.string(),
    slippageBps: z.number().default(100), // 1% default
});
export const createPoolAndAddLiquidityInputSchema = z.object({
    tokenAMint: z.string(),
    tokenBMint: z.string(),
    tokenAAmount: z.string(),
    tokenBAmount: z.string(),
    userPublicKey: z.string(),
    initialPrice: z.number(), // Price of tokenA in terms of tokenB
    lockLiquidity: z.boolean().default(false),
    positionNftMint: z.string().optional(), // If provided, client will sign with their keypair
});
export const lockPositionInputSchema = z.object({
    poolAddress: z.string(),
    positionAddress: z.string(),
    positionLiquidity: z.string(), // Amount of liquidity to lock
    userPublicKey: z.string(),
});
// Lazy initialization of CpAmm SDK with warmup
let cpAmmInstance = null;
let sdkInitialized = false;
let warmupPromise = null;
export function getCpAmm() {
    if (!cpAmmInstance) {
        console.log('[METEORA] Initializing CpAmm SDK...');
        const startTime = Date.now();
        cpAmmInstance = new CpAmm(connection);
        console.log(`[METEORA] CpAmm SDK initialized in ${Date.now() - startTime}ms`);
    }
    return cpAmmInstance;
}
// Warmup function - call this on server start to pre-initialize the SDK
export async function warmupMeteoraSDK() {
    if (sdkInitialized)
        return;
    if (warmupPromise)
        return warmupPromise;
    console.log('[METEORA] Warming up SDK...');
    const startTime = Date.now();
    warmupPromise = (async () => {
        try {
            const cpAmm = getCpAmm();
            // Make a simple call to ensure SDK is fully loaded
            const configs = await cpAmm.getAllConfigs();
            console.log(`[METEORA] SDK warmup complete in ${Date.now() - startTime}ms, found ${configs.length} configs`);
            sdkInitialized = true;
        }
        catch (error) {
            console.error('[METEORA] SDK warmup failed:', error);
            // Don't throw - allow requests to proceed and try again
        }
    })();
    return warmupPromise;
}
// Wait for SDK to be ready (with timeout)
export async function waitForSDKReady(timeoutMs = 10000) {
    if (sdkInitialized)
        return true;
    // Start warmup if not already started
    if (!warmupPromise) {
        warmupMeteoraSDK();
    }
    // Wait for warmup with timeout
    const startTime = Date.now();
    while (!sdkInitialized && (Date.now() - startTime) < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return sdkInitialized;
}
// Auto-warmup on module load (runs in background)
setTimeout(() => {
    warmupMeteoraSDK().catch(console.error);
}, 100); // Start warmup quickly
/**
 * Convert legacy Transaction to VersionedTransaction and serialize as base64
 * Server signs with provided keypairs, client will add their wallet signature
 */
async function serializeTransaction(tx, payer, signers = []) {
    console.log('[serializeTransaction] Starting...');
    console.log('[serializeTransaction] Instructions count:', tx.instructions.length);
    console.log('[serializeTransaction] Payer:', payer.toBase58());
    console.log('[serializeTransaction] Signers:', signers.map(s => s.publicKey.toBase58()));
    try {
        const { blockhash } = await connection.getLatestBlockhash();
        console.log('[serializeTransaction] Got blockhash:', blockhash);
        // Convert legacy Transaction to VersionedTransaction
        const messageV0 = new TransactionMessage({
            payerKey: payer,
            recentBlockhash: blockhash,
            instructions: tx.instructions,
        }).compileToV0Message();
        console.log('[serializeTransaction] Compiled to V0 message');
        const versionedTx = new VersionedTransaction(messageV0);
        console.log('[serializeTransaction] Created VersionedTransaction');
        // Log required signatures
        const requiredSigs = versionedTx.message.header.numRequiredSignatures;
        console.log(`Transaction requires ${requiredSigs} signature(s)`);
        if (signers.length > 0) {
            // Server signs with provided keypairs
            versionedTx.sign(signers);
            console.log(`Server signed transaction with ${signers.length} signer(s)`);
            console.log('Signer pubkeys:', signers.map(s => s.publicKey.toBase58()));
        }
        // Log signature status for debugging
        const sigCount = versionedTx.signatures.filter(sig => !sig.every(b => b === 0)).length;
        console.log(`Transaction has ${sigCount}/${requiredSigs} signatures`);
        // Serialize the versioned transaction
        console.log('[serializeTransaction] Serializing...');
        const serialized = versionedTx.serialize();
        console.log('[serializeTransaction] Serialized, length:', serialized.length);
        const base64 = Buffer.from(serialized).toString('base64');
        console.log('[serializeTransaction] Base64 encoded, length:', base64.length);
        return base64;
    }
    catch (error) {
        console.error('[serializeTransaction] Error:', error);
        console.error('[serializeTransaction] Error stack:', error instanceof Error ? error.stack : 'No stack');
        throw error;
    }
}
// NOTE: Position NFT accounts are PDAs derived by the DAMM V2 program using derivePositionNftAccount()
// They are NOT regular ATAs. The SDK handles Token-2022 internally.
/**
 * Detect which token program a mint belongs to by checking the account owner
 * Returns TOKEN_2022_PROGRAM_ID for Token-2022 mints, TOKEN_PROGRAM_ID for regular SPL tokens
 */
async function getTokenProgramForMint(mint) {
    try {
        const accountInfo = await connection.getAccountInfo(mint);
        if (!accountInfo) {
            console.log(`[getTokenProgramForMint] Mint ${mint.toBase58()} not found, defaulting to SPL Token`);
            return TOKEN_PROGRAM_ID;
        }
        const owner = accountInfo.owner;
        if (owner.equals(TOKEN_2022_PROGRAM_ID)) {
            console.log(`[getTokenProgramForMint] Mint ${mint.toBase58()} is Token-2022`);
            return TOKEN_2022_PROGRAM_ID;
        }
        else {
            console.log(`[getTokenProgramForMint] Mint ${mint.toBase58()} is SPL Token`);
            return TOKEN_PROGRAM_ID;
        }
    }
    catch (error) {
        console.error(`[getTokenProgramForMint] Error checking mint ${mint.toBase58()}:`, error);
        return TOKEN_PROGRAM_ID; // Default to SPL Token on error
    }
}
/**
 * Get associated token address with correct program ID based on mint type
 */
export async function getAssociatedTokenAddressForMint(mint, owner) {
    const tokenProgram = await getTokenProgramForMint(mint);
    const ata = getAssociatedTokenAddressSync(mint, owner, false, // allowOwnerOffCurve
    tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
    return { ata, tokenProgram };
}
/**
 * Create ATA instruction with correct program ID based on mint type
 */
export function createAtaInstructionForMint(payer, ata, owner, mint, tokenProgram) {
    return createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
}
/**
 * Find existing pool for token pair using fetchPoolStatesByTokenAMint
 * This is more reliable than derivePoolAddress because it finds pools
 * regardless of which config they were created with
 */
export async function findPool(tokenAMint, tokenBMint) {
    const POOL_SEARCH_TIMEOUT = 15000; // 15 second timeout for pool search
    try {
        const cpAmm = getCpAmm();
        const tokenA = new PublicKey(tokenAMint);
        const tokenB = new PublicKey(tokenBMint);
        console.log('[findPool] Searching for pool with tokens:', tokenAMint, tokenBMint);
        const searchStart = Date.now();
        // Method 1: Try to fetch pools by tokenA mint
        try {
            const poolsByTokenA = await withTimeout(cpAmm.fetchPoolStatesByTokenAMint(tokenA), POOL_SEARCH_TIMEOUT, 'fetchPoolStatesByTokenAMint(tokenA)');
            console.log(`[findPool] Found ${poolsByTokenA.length} pools with tokenA as base (${Date.now() - searchStart}ms)`);
            // Find a pool that has tokenB as the other token
            for (const pool of poolsByTokenA) {
                if (pool.account.tokenBMint.equals(tokenB)) {
                    console.log('Found matching pool:', pool.publicKey.toBase58());
                    return {
                        exists: true,
                        poolAddress: pool.publicKey.toBase58(),
                        poolState: pool.account,
                    };
                }
            }
        }
        catch (e) {
            console.log('Error fetching pools by tokenA:', e);
        }
        // Method 2: Try with tokens reversed (tokenB as base)
        try {
            const poolsByTokenB = await withTimeout(cpAmm.fetchPoolStatesByTokenAMint(tokenB), POOL_SEARCH_TIMEOUT, 'fetchPoolStatesByTokenAMint(tokenB)');
            console.log(`[findPool] Found ${poolsByTokenB.length} pools with tokenB as base (${Date.now() - searchStart}ms)`);
            // Find a pool that has tokenA as the other token
            for (const pool of poolsByTokenB) {
                if (pool.account.tokenBMint.equals(tokenA)) {
                    console.log('Found matching pool (reversed):', pool.publicKey.toBase58());
                    return {
                        exists: true,
                        poolAddress: pool.publicKey.toBase58(),
                        poolState: pool.account,
                    };
                }
            }
        }
        catch (e) {
            console.log('Error fetching pools by tokenB:', e);
        }
        // Method 3: Fallback to derivePoolAddress with standard config
        // This only works if the pool was created with our standard config
        console.log('No pool found via search, trying derivation with standard config...');
        const derivedPoolAddress = derivePoolAddress(METEORA_STANDARD_CONFIG, tokenA, tokenB);
        try {
            const exists = await cpAmm.isPoolExist(derivedPoolAddress);
            if (exists) {
                const poolState = await cpAmm.fetchPoolState(derivedPoolAddress);
                console.log('Found pool via derivation:', derivedPoolAddress.toBase58());
                return {
                    exists: true,
                    poolAddress: derivedPoolAddress.toBase58(),
                    poolState: poolState,
                };
            }
        }
        catch {
            // Pool doesn't exist with this token order
        }
        // Try reversed order with derivation
        const derivedPoolAddressReversed = derivePoolAddress(METEORA_STANDARD_CONFIG, tokenB, tokenA);
        try {
            const exists = await cpAmm.isPoolExist(derivedPoolAddressReversed);
            if (exists) {
                const poolState = await cpAmm.fetchPoolState(derivedPoolAddressReversed);
                console.log('Found pool via derivation (reversed):', derivedPoolAddressReversed.toBase58());
                return {
                    exists: true,
                    poolAddress: derivedPoolAddressReversed.toBase58(),
                    poolState: poolState,
                };
            }
        }
        catch {
            // Pool doesn't exist
        }
        console.log('No existing pool found for token pair');
        return {
            exists: false,
            poolAddress: null,
            poolState: null,
        };
    }
    catch (error) {
        console.error('Error finding pool:', error);
        return {
            exists: false,
            poolAddress: null,
            poolState: null,
        };
    }
}
/**
 * Get deposit quote for adding liquidity
 */
export async function getDepositQuote(poolAddress, tokenAAmount, isTokenA = true) {
    try {
        const cpAmm = getCpAmm();
        const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
        if (!poolState)
            return null;
        const inAmount = new BN(tokenAAmount);
        const quote = cpAmm.getDepositQuote({
            inAmount,
            isTokenA,
            minSqrtPrice: poolState.sqrtMinPrice,
            maxSqrtPrice: poolState.sqrtMaxPrice,
            sqrtPrice: poolState.sqrtPrice,
        });
        return {
            tokenAAmount: quote.consumedInputAmount.toString(),
            tokenBAmount: quote.outputAmount.toString(),
            liquidityDelta: quote.liquidityDelta.toString(),
        };
    }
    catch (error) {
        console.error('Error getting deposit quote:', error);
        return null;
    }
}
/**
 * Get token decimals from mint
 */
async function getTokenDecimals(mint) {
    try {
        const info = await connection.getParsedAccountInfo(mint);
        return info.value?.data?.parsed?.info?.decimals || 9;
    }
    catch {
        return 9; // Default to 9 decimals
    }
}
/**
 * Build transaction to create a new pool with initial liquidity
 * createPool() creates pool + initial position + adds liquidity in one transaction
 */
export async function buildCreatePoolTransaction(input) {
    try {
        const cpAmm = getCpAmm();
        const { tokenAMint, tokenBMint, tokenAAmount, tokenBAmount, userPublicKey, initialPrice, lockLiquidity } = input;
        const user = new PublicKey(userPublicKey);
        const tokenA = new PublicKey(tokenAMint);
        const tokenB = new PublicKey(tokenBMint);
        // Generate position NFT keypair on server and sign with it
        const positionNftMint = Keypair.generate();
        const positionNftPubkey = positionNftMint.publicKey;
        console.log('Generated server position NFT mint:', positionNftPubkey.toBase58());
        // Get token decimals
        const tokenADecimals = await getTokenDecimals(tokenA);
        const tokenBDecimals = await getTokenDecimals(tokenB);
        // Calculate sqrt price from initial price
        const sqrtPrice = getSqrtPriceFromPrice(initialPrice.toString(), tokenADecimals, tokenBDecimals);
        // Get deposit quote for initial liquidity
        const depositQuote = cpAmm.getDepositQuote({
            inAmount: new BN(tokenAAmount),
            isTokenA: true,
            minSqrtPrice: new BN(1), // Min sqrt price
            maxSqrtPrice: new BN('340282366920938463463374607431768211455'), // Max U128
            sqrtPrice,
        });
        // Create associated token accounts for the user if they don't exist
        // Use Token-2022 aware helper to detect correct program for each mint
        const { ata: userTokenAAta, tokenProgram: tokenAProgram } = await getAssociatedTokenAddressForMint(tokenA, user);
        const { ata: userTokenBAta, tokenProgram: tokenBProgram } = await getAssociatedTokenAddressForMint(tokenB, user);
        console.log('[createPool] TokenA program:', tokenAProgram.toBase58());
        console.log('[createPool] TokenB program:', tokenBProgram.toBase58());
        // Build ATA creation instructions with correct token programs
        const createAtaInstructions = [
            createAtaInstructionForMint(user, userTokenAAta, user, tokenA, tokenAProgram),
            createAtaInstructionForMint(user, userTokenBAta, user, tokenB, tokenBProgram),
        ];
        // Build create pool transaction - creates pool + position + adds initial liquidity
        // Pass the correct token program for each mint
        const tx = await cpAmm.createPool({
            payer: user,
            creator: user,
            config: METEORA_STANDARD_CONFIG,
            positionNft: positionNftPubkey,
            tokenAMint: tokenA,
            tokenBMint: tokenB,
            activationPoint: null,
            tokenAAmount: new BN(tokenAAmount),
            tokenBAmount: new BN(tokenBAmount),
            initSqrtPrice: sqrtPrice,
            liquidityDelta: depositQuote.liquidityDelta,
            tokenAProgram: tokenAProgram, // Use detected program
            tokenBProgram: tokenBProgram, // Use detected program
            isLockLiquidity: lockLiquidity, // Lock liquidity if requested
        });
        // Prepend ATA creation instructions
        tx.instructions = [...createAtaInstructions, ...tx.instructions];
        // Serialize transaction - server signs with position keypair
        const serializedTx = await serializeTransaction(tx, user, [positionNftMint]);
        // Derive pool address
        const poolAddress = derivePoolAddress(METEORA_STANDARD_CONFIG, tokenA, tokenB);
        return {
            success: true,
            transaction: serializedTx,
            poolAddress: poolAddress.toBase58(),
            positionAddress: positionNftPubkey.toBase58(),
            positionNftMint: positionNftPubkey.toBase58(), // NFT mint for transfers
            needsClientSigning: false, // Server already signed with position keypair
            error: null,
        };
    }
    catch (error) {
        console.error('Error building create pool transaction:', error);
        console.error('Error stack:', error instanceof Error ? error.stack : 'No stack');
        console.error('Input values:', JSON.stringify(input, null, 2));
        return {
            success: false,
            transaction: null,
            poolAddress: null,
            positionAddress: null,
            needsClientSigning: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
/**
 * Build transactions to add liquidity to existing pool
 *
 * Flow:
 * 1. Check if user has existing position
 * 2. If no position: create position first, then add liquidity (2 transactions)
 * 3. If position exists: add liquidity directly (1 transaction)
 */
export async function buildAddLiquidityTransaction(input) {
    try {
        const cpAmm = getCpAmm();
        const { poolAddress, tokenAMint, tokenBMint, tokenAAmount, tokenBAmount, userPublicKey, slippageBps } = input;
        const user = new PublicKey(userPublicKey);
        const pool = new PublicKey(poolAddress);
        // Fetch pool state first to get the actual token mints
        const poolState = await cpAmm.fetchPoolState(pool);
        if (!poolState) {
            return {
                success: false,
                transactions: [],
                positionAddress: null,
                error: 'Pool not found',
            };
        }
        // Use the token mints from the pool state, not from input
        // This ensures we're using the correct token order
        const tokenA = poolState.tokenAMint;
        const tokenB = poolState.tokenBMint;
        console.log('Pool tokenA:', tokenA.toBase58());
        console.log('Pool tokenB:', tokenB.toBase58());
        console.log('Input tokenA:', tokenAMint);
        console.log('Input tokenB:', tokenBMint);
        // Determine if we need to swap the amounts based on token order
        const inputTokenA = new PublicKey(tokenAMint);
        const isTokenOrderMatched = tokenA.equals(inputTokenA);
        const actualTokenAAmount = isTokenOrderMatched ? tokenAAmount : tokenBAmount;
        const actualTokenBAmount = isTokenOrderMatched ? tokenBAmount : tokenAAmount;
        console.log('Token order matched:', isTokenOrderMatched);
        console.log('Actual tokenA amount:', actualTokenAAmount);
        console.log('Actual tokenB amount:', actualTokenBAmount);
        // Create associated token accounts for the user if they don't exist
        // Use Token-2022 aware helper to detect correct program for each mint
        const { ata: userTokenAAta, tokenProgram: tokenAProgram } = await getAssociatedTokenAddressForMint(tokenA, user);
        const { ata: userTokenBAta, tokenProgram: tokenBProgram } = await getAssociatedTokenAddressForMint(tokenB, user);
        console.log('[addLiquidity] TokenA program:', tokenAProgram.toBase58());
        console.log('[addLiquidity] TokenB program:', tokenBProgram.toBase58());
        // Build ATA creation instructions with correct token programs
        const createAtaInstructions = [
            createAtaInstructionForMint(user, userTokenAAta, user, tokenA, tokenAProgram),
            createAtaInstructionForMint(user, userTokenBAta, user, tokenB, tokenBProgram),
        ];
        // ALWAYS create a new position for each transaction so each user gets their own NFT
        // Don't reuse existing positions - each LP deposit should result in a unique NFT
        const userPositions = await cpAmm.getUserPositionByPool(pool, user);
        console.log(`User has ${userPositions.length} existing position(s) in pool (ignoring - creating new)`);
        const transactions = [];
        let positionNftMint = null;
        let positionAddress;
        let positionNftAccount;
        // Always create new position so user gets their own NFT
        console.log('Creating NEW position for user (each user gets unique NFT)...');
        positionNftMint = Keypair.generate();
        const positionNftMintPubkey = positionNftMint.publicKey;
        // Derive the position PDA using the SDK function
        // The position is a PDA derived from the pool and position NFT mint
        positionAddress = derivePositionAddress(positionNftMintPubkey);
        console.log('Position NFT mint:', positionNftMintPubkey.toBase58());
        console.log('Position PDA:', positionAddress.toBase58());
        // Position NFT account - use the SDK's derivation function
        // This is a PDA derived from the DAMM V2 program, NOT a regular ATA
        positionNftAccount = derivePositionNftAccount(positionNftMintPubkey);
        console.log('Position NFT account (PDA):', positionNftAccount.toBase58());
        // Build create position transaction
        // positionNft should be the NFT mint keypair's public key, not the position PDA
        const createPositionTx = await cpAmm.createPosition({
            owner: user,
            payer: user,
            pool,
            positionNft: positionNftMintPubkey, // Use the NFT mint, not the position PDA
        });
        // Prepend ATA creation instructions
        createPositionTx.instructions = [...createAtaInstructions, ...createPositionTx.instructions];
        // Serialize - server signs with position keypair
        const serializedCreateTx = await serializeTransaction(createPositionTx, user, [positionNftMint]);
        transactions.push(serializedCreateTx);
        console.log('Created position transaction added');
        // Use getDepositQuote to calculate the correct liquidityDelta and amounts
        // This is the proper way according to Meteora SDK documentation
        const tokenAAmountBN = new BN(actualTokenAAmount);
        const tokenBAmountBN = new BN(actualTokenBAmount);
        console.log('Input tokenA amount:', actualTokenAAmount);
        console.log('Input tokenB amount:', actualTokenBAmount);
        console.log('Pool sqrtPrice:', poolState.sqrtPrice.toString());
        console.log('Pool sqrtMinPrice:', poolState.sqrtMinPrice.toString());
        console.log('Pool sqrtMaxPrice:', poolState.sqrtMaxPrice.toString());
        // Try deposit quote with tokenA first
        let depositQuote = cpAmm.getDepositQuote({
            inAmount: tokenAAmountBN,
            isTokenA: true,
            minSqrtPrice: poolState.sqrtMinPrice,
            maxSqrtPrice: poolState.sqrtMaxPrice,
            sqrtPrice: poolState.sqrtPrice,
        });
        console.log('Deposit quote (tokenA as input):');
        console.log('  actualInputAmount:', depositQuote.actualInputAmount.toString());
        console.log('  consumedInputAmount:', depositQuote.consumedInputAmount.toString());
        console.log('  outputAmount (tokenB needed):', depositQuote.outputAmount.toString());
        console.log('  liquidityDelta:', depositQuote.liquidityDelta.toString());
        // Check if we have enough tokenB for this deposit
        // If outputAmount > tokenBAmount, we need more tokenB than we have
        // In that case, try with tokenB as input instead
        let useTokenAAsInput = true;
        if (depositQuote.outputAmount.gt(tokenBAmountBN)) {
            console.log('WARNING: TokenA deposit requires more tokenB than available!');
            console.log('  Required tokenB:', depositQuote.outputAmount.toString());
            console.log('  Available tokenB:', tokenBAmountBN.toString());
            console.log('Trying with tokenB as input instead...');
            // Try with tokenB as input
            depositQuote = cpAmm.getDepositQuote({
                inAmount: tokenBAmountBN,
                isTokenA: false,
                minSqrtPrice: poolState.sqrtMinPrice,
                maxSqrtPrice: poolState.sqrtMaxPrice,
                sqrtPrice: poolState.sqrtPrice,
            });
            useTokenAAsInput = false;
            console.log('Deposit quote (tokenB as input):');
            console.log('  actualInputAmount:', depositQuote.actualInputAmount.toString());
            console.log('  consumedInputAmount:', depositQuote.consumedInputAmount.toString());
            console.log('  outputAmount (tokenA needed):', depositQuote.outputAmount.toString());
            console.log('  liquidityDelta:', depositQuote.liquidityDelta.toString());
            // Check if we have enough tokenA for this deposit
            if (depositQuote.outputAmount.gt(tokenAAmountBN)) {
                console.log('ERROR: Neither token has enough balance for deposit!');
                console.log('  TokenB deposit requires tokenA:', depositQuote.outputAmount.toString());
                console.log('  Available tokenA:', tokenAAmountBN.toString());
                throw new Error(`Insufficient token balances for LP deposit. Need tokenA: ${depositQuote.outputAmount.toString()}, have: ${tokenAAmountBN.toString()}`);
            }
        }
        console.log('Using', useTokenAAsInput ? 'tokenA' : 'tokenB', 'as input token');
        // Apply slippage tolerance to the amounts
        // slippageBps is in basis points (100 = 1%)
        const slippageMultiplier = 10000 + slippageBps;
        // Max amounts and thresholds depend on which token is input
        let maxTokenA, maxTokenB, thresholdA, thresholdB;
        if (useTokenAAsInput) {
            // TokenA is input, tokenB is output
            maxTokenA = depositQuote.consumedInputAmount.mul(new BN(slippageMultiplier)).div(new BN(10000));
            maxTokenB = depositQuote.outputAmount.mul(new BN(slippageMultiplier)).div(new BN(10000));
            thresholdA = depositQuote.consumedInputAmount;
            thresholdB = depositQuote.outputAmount;
        }
        else {
            // TokenB is input, tokenA is output
            maxTokenB = depositQuote.consumedInputAmount.mul(new BN(slippageMultiplier)).div(new BN(10000));
            maxTokenA = depositQuote.outputAmount.mul(new BN(slippageMultiplier)).div(new BN(10000));
            thresholdB = depositQuote.consumedInputAmount;
            thresholdA = depositQuote.outputAmount;
        }
        console.log('maxTokenA (with slippage):', maxTokenA.toString());
        console.log('maxTokenB (with slippage):', maxTokenB.toString());
        console.log('thresholdA:', thresholdA.toString());
        console.log('thresholdB:', thresholdB.toString());
        // Build add liquidity transaction with correct token programs
        const addLiquidityTx = await cpAmm.addLiquidity({
            owner: user,
            pool,
            position: positionAddress,
            positionNftAccount,
            liquidityDelta: depositQuote.liquidityDelta,
            maxAmountTokenA: maxTokenA,
            maxAmountTokenB: maxTokenB,
            tokenAAmountThreshold: thresholdA,
            tokenBAmountThreshold: thresholdB,
            tokenAMint: tokenA,
            tokenBMint: tokenB,
            tokenAVault: poolState.tokenAVault,
            tokenBVault: poolState.tokenBVault,
            tokenAProgram: tokenAProgram, // Use detected program
            tokenBProgram: tokenBProgram, // Use detected program
        });
        // If we created a new position, don't prepend ATA instructions again
        if (userPositions.length > 0) {
            addLiquidityTx.instructions = [...createAtaInstructions, ...addLiquidityTx.instructions];
        }
        // Serialize - no additional signers needed for add liquidity
        const serializedAddLiqTx = await serializeTransaction(addLiquidityTx, user);
        transactions.push(serializedAddLiqTx);
        console.log('Add liquidity transaction added');
        return {
            success: true,
            transactions,
            positionAddress: positionAddress.toBase58(),
            positionNftMint: positionNftMint ? positionNftMint.publicKey.toBase58() : undefined, // Return NFT mint for transfers
            liquidityDelta: depositQuote.liquidityDelta.toString(), // Return for lock transaction
            error: null,
        };
    }
    catch (error) {
        console.error('Error building add liquidity transaction:', error);
        return {
            success: false,
            transactions: [],
            positionAddress: null,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
/**
 * Build transaction to permanently lock LP position
 */
export async function buildLockPositionTransaction(input) {
    try {
        const cpAmm = getCpAmm();
        const { poolAddress, positionAddress, positionLiquidity, userPublicKey } = input;
        const user = new PublicKey(userPublicKey);
        const pool = new PublicKey(poolAddress);
        const position = new PublicKey(positionAddress);
        // Fetch position state to get the NFT mint
        const positionState = await cpAmm.fetchPositionState(position);
        if (!positionState) {
            return {
                success: false,
                transaction: null,
                error: 'Position not found',
            };
        }
        // Get position NFT account using SDK derivation (it's a PDA, not an ATA)
        const positionNftAccount = derivePositionNftAccount(positionState.nftMint);
        // Build permanent lock transaction
        const tx = await cpAmm.permanentLockPosition({
            owner: user,
            pool,
            position,
            positionNftAccount,
            unlockedLiquidity: new BN(positionLiquidity),
        });
        const serializedTx = await serializeTransaction(tx, user);
        return {
            success: true,
            transaction: serializedTx,
            error: null,
        };
    }
    catch (error) {
        console.error('Error building lock position transaction:', error);
        return {
            success: false,
            transaction: null,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
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
export async function buildLiquidityProvisioningTransactions(tokenAMint, tokenBMint, tokenAAmount, tokenBAmount, userPublicKey, lockLiquidity = false, positionNftMintStr) {
    const startTime = Date.now();
    console.log('=== buildLiquidityProvisioningTransactions START ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('tokenAMint:', tokenAMint);
    console.log('tokenBMint:', tokenBMint);
    console.log('tokenAAmount:', tokenAAmount);
    console.log('tokenBAmount:', tokenBAmount);
    console.log('userPublicKey:', userPublicKey);
    console.log('lockLiquidity:', lockLiquidity);
    try {
        // Check if pool exists
        console.log('Checking if pool exists...');
        const poolInfo = await findPool(tokenAMint, tokenBMint);
        console.log('Pool info:', JSON.stringify(poolInfo, null, 2));
        if (poolInfo.exists && poolInfo.poolAddress) {
            // Pool exists - add liquidity to existing pool
            console.log('Pool exists, building add liquidity transactions...');
            const addLiqResult = await buildAddLiquidityTransaction({
                poolAddress: poolInfo.poolAddress,
                tokenAMint,
                tokenBMint,
                tokenAAmount,
                tokenBAmount,
                userPublicKey,
                slippageBps: 5000, // 50% slippage for LP (very high because amounts are estimated from quote, actual may differ after swap)
            });
            if (!addLiqResult.success || addLiqResult.transactions.length === 0) {
                return {
                    success: false,
                    transactions: [],
                    poolAddress: poolInfo.poolAddress,
                    positionAddress: null,
                    isNewPool: false,
                    error: addLiqResult.error || 'Failed to build add liquidity transactions',
                    needsPositionSigner: false,
                };
            }
            const transactions = [...addLiqResult.transactions];
            // NOTE: Lock transaction CANNOT be bundled with create position + add liquidity
            // because the lock requires the position to exist on-chain first.
            // The caller must:
            // 1. Submit create position + add liquidity transactions
            // 2. Wait for confirmation
            // 3. Then call buildLockPositionTransaction separately
            // We return lockLiquidity flag and liquidityDelta so caller knows to lock after
            if (lockLiquidity) {
                console.log('Lock liquidity requested - caller must lock AFTER position is created on-chain');
                console.log('Liquidity delta to lock:', addLiqResult.liquidityDelta);
            }
            return {
                success: true,
                transactions,
                poolAddress: poolInfo.poolAddress,
                positionAddress: addLiqResult.positionAddress,
                positionNftMint: addLiqResult.positionNftMint, // NFT mint for transfers
                liquidityDelta: addLiqResult.liquidityDelta, // For locking after position is created
                isNewPool: false,
                error: null,
                needsPositionSigner: false, // Server already signed with position keypair
            };
        }
        else {
            // Pool doesn't exist - CREATE NEW POOL
            console.log('Pool does not exist, creating new pool...');
            // Get token decimals to calculate initial price
            const tokenADecimals = await getTokenDecimals(new PublicKey(tokenAMint));
            const tokenBDecimals = await getTokenDecimals(new PublicKey(tokenBMint));
            // Calculate initial price from the amounts
            // Price = tokenBAmount / tokenAAmount (adjusted for decimals)
            const tokenAAmountNum = parseFloat(tokenAAmount) / Math.pow(10, tokenADecimals);
            const tokenBAmountNum = parseFloat(tokenBAmount) / Math.pow(10, tokenBDecimals);
            const initialPrice = tokenBAmountNum / tokenAAmountNum;
            console.log('Initial price:', initialPrice);
            console.log('TokenA decimals:', tokenADecimals);
            console.log('TokenB decimals:', tokenBDecimals);
            const createPoolResult = await buildCreatePoolTransaction({
                tokenAMint,
                tokenBMint,
                tokenAAmount,
                tokenBAmount,
                userPublicKey,
                initialPrice,
                lockLiquidity,
            });
            if (!createPoolResult.success || !createPoolResult.transaction) {
                console.error('Failed to create pool:', createPoolResult.error);
                return {
                    success: false,
                    transactions: [],
                    poolAddress: null,
                    positionAddress: null,
                    isNewPool: true,
                    error: createPoolResult.error || 'Failed to build create pool transaction',
                    needsPositionSigner: false,
                };
            }
            console.log('Pool creation transaction built successfully');
            console.log('New pool address:', createPoolResult.poolAddress);
            console.log('Position address:', createPoolResult.positionAddress);
            return {
                success: true,
                transactions: [createPoolResult.transaction],
                poolAddress: createPoolResult.poolAddress,
                positionAddress: createPoolResult.positionAddress,
                positionNftMint: createPoolResult.positionNftMint, // NFT mint for transfers
                isNewPool: true,
                error: null,
                needsPositionSigner: false, // Server already signed with position keypair
            };
        }
    }
    catch (error) {
        const elapsed = Date.now() - startTime;
        console.error('=== buildLiquidityProvisioningTransactions ERROR ===');
        console.error('Elapsed time:', elapsed, 'ms');
        console.error('Error type:', error?.constructor?.name);
        console.error('Error message:', error instanceof Error ? error.message : String(error));
        console.error('Error stack:', error instanceof Error ? error.stack : 'No stack');
        // Return detailed error info
        const errorMessage = error instanceof Error
            ? `${error.name}: ${error.message} (after ${elapsed}ms)`
            : `Unknown error after ${elapsed}ms`;
        return {
            success: false,
            transactions: [],
            poolAddress: null,
            positionAddress: null,
            isNewPool: false,
            error: errorMessage,
            needsPositionSigner: false,
        };
    }
}
//# sourceMappingURL=meteora-damm.js.map