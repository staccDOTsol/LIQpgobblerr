/**
 * Automated Trading & Liquidity System
 *
 * Monitors incoming SOL transactions, swaps into PROOF V3 + trending memecoin,
 * creates/adds to Meteora DAMM V2 pools, locks liquidity, and sends LP NFT to sender.
 *
 * Uses existing Liquidity Monster backend APIs for all operations.
 */
import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { isTransactionProcessed, insertProcessedIncoming, updateProcessedIncoming, getProcessedIncomingBySignature, markForRetry, getTransactionsForRetry } from './db.js';
import { findPool } from './meteora-damm.js';
// Constants - Use the existing Helius API key from constants or environment
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '0d4b4fd6-c2fc-4f55-b615-a23bab1ffc85';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
// Birdeye API key (provided by user)
const BIRDEYE_API_KEY = 'eeb246144fc1461d9036b52e1bbf5cf3';
const BIRDEYE_API_URL = 'https://public-api.birdeye.so';
const PROOF_V3_MINT = 'CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const MIN_SOL_LAMPORTS = 10_000_000; // 0.01 SOL minimum
const SWAP_PERCENTAGE = 0.475; // 47.5% per swap (95% total, 5% kept as fee)
// Connection
const connection = new Connection(HELIUS_RPC_URL, 'confirmed');
let cachedTrendingToken = null;
let lastTrendingFetch = 0;
const TRENDING_CACHE_TTL_MS = 1000; // 1 second cache
async function getTopTrendingMemecoin() {
    const now = Date.now();
    // Return cached result if still valid
    if (cachedTrendingToken && (now - lastTrendingFetch) < TRENDING_CACHE_TTL_MS) {
        return cachedTrendingToken;
    }
    try {
        // Fetch trending tokens from Birdeye
        const response = await fetch(`${BIRDEYE_API_URL}/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=10`, {
            headers: {
                'X-API-KEY': BIRDEYE_API_KEY,
                'x-chain': 'solana',
            },
        });
        if (!response.ok) {
            console.error('[BIRDEYE] Failed to fetch trending tokens:', response.status);
            return cachedTrendingToken; // Return stale cache on error
        }
        const data = await response.json();
        console.log('[BIRDEYE] API response:', JSON.stringify(data).substring(0, 500));
        // Handle both possible response formats
        const items = data.data?.items || data.data?.tokens || [];
        console.log(`[BIRDEYE] Found ${items.length} trending tokens`);
        if (items.length > 0) {
            const top = items[0];
            cachedTrendingToken = {
                address: top.address,
                symbol: top.symbol,
                name: top.name,
                price: top.price || 0,
                priceChange24h: top.priceChange24hPercent || 0,
                volume24h: top.volume24h || 0,
            };
            lastTrendingFetch = now;
            console.log(`[BIRDEYE] Cached trending token: ${cachedTrendingToken.symbol} (${cachedTrendingToken.address})`);
        }
        return cachedTrendingToken;
    }
    catch (error) {
        console.error('[BIRDEYE] Error fetching trending tokens:', error);
        return cachedTrendingToken; // Return stale cache on error
    }
}
// ============================================================================
// System Wallet Management
// ============================================================================
let systemWallet = null;
// Load wallet from environment variable (SYSTEM_WALLET_PRIVATE_KEY)
async function getOrCreateSystemWallet() {
    if (systemWallet) {
        return systemWallet;
    }
    const privateKey = process.env.SYSTEM_WALLET_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error('SYSTEM_WALLET_PRIVATE_KEY environment variable is not set');
    }
    try {
        systemWallet = Keypair.fromSecretKey(bs58.decode(privateKey));
        console.log(`[WALLET] Loaded system wallet from env: ${systemWallet.publicKey.toBase58()}`);
        return systemWallet;
    }
    catch (error) {
        throw new Error(`Failed to load wallet from SYSTEM_WALLET_PRIVATE_KEY: ${error}`);
    }
}
function getSystemWalletSync() {
    return systemWallet;
}
let lastProcessedSignature = null;
let processedSignatures = new Set();
async function checkForIncomingTransactions() {
    const wallet = getSystemWalletSync();
    if (!wallet) {
        return [];
    }
    try {
        // Get recent signatures for the system wallet
        const signatures = await connection.getSignaturesForAddress(wallet.publicKey, { limit: 20 }, 'confirmed');
        const newTransactions = [];
        for (const sig of signatures) {
            // Skip already processed (check in-memory cache first, then database)
            if (processedSignatures.has(sig.signature)) {
                continue;
            }
            // Check database for previously processed transactions
            const alreadyProcessed = await isTransactionProcessed(sig.signature);
            if (alreadyProcessed) {
                processedSignatures.add(sig.signature); // Add to in-memory cache
                continue;
            }
            // Get transaction details
            const tx = await connection.getTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0,
            });
            if (!tx || !tx.meta)
                continue;
            // Check if this is an incoming SOL transfer to our wallet
            const preBalances = tx.meta.preBalances;
            const postBalances = tx.meta.postBalances;
            // Use staticAccountKeys to avoid address table lookup issues
            // For versioned transactions, we need to handle this differently
            const message = tx.transaction.message;
            let accountKeys = [];
            // Handle both legacy and versioned transactions
            if ('staticAccountKeys' in message) {
                // Versioned transaction - use static keys only (avoid address table lookups)
                accountKeys = message.staticAccountKeys;
            }
            else if ('accountKeys' in message) {
                // Legacy transaction
                accountKeys = message.accountKeys;
            }
            if (accountKeys.length === 0)
                continue;
            // Find our wallet's index
            let ourIndex = -1;
            for (let i = 0; i < accountKeys.length; i++) {
                if (accountKeys[i]?.equals(wallet.publicKey)) {
                    ourIndex = i;
                    break;
                }
            }
            if (ourIndex === -1)
                continue;
            // Calculate incoming amount
            const balanceChange = postBalances[ourIndex] - preBalances[ourIndex];
            // Only process incoming transfers above minimum
            if (balanceChange >= MIN_SOL_LAMPORTS) {
                // Find sender (first account that's not us and has negative balance change)
                let sender = '';
                for (let i = 0; i < accountKeys.length; i++) {
                    if (i !== ourIndex && (postBalances[i] - preBalances[i]) < 0) {
                        sender = accountKeys[i]?.toBase58() || '';
                        break;
                    }
                }
                if (sender) {
                    newTransactions.push({
                        signature: sig.signature,
                        sender,
                        amount: balanceChange,
                        slot: sig.slot,
                        blockTime: sig.blockTime || 0,
                    });
                    processedSignatures.add(sig.signature);
                    console.log(`[MONITOR] New incoming tx: ${sig.signature} from ${sender} for ${balanceChange / 1e9} SOL`);
                }
            }
            else {
                // Mark as processed even if below threshold
                processedSignatures.add(sig.signature);
            }
        }
        return newTransactions;
    }
    catch (error) {
        console.error('[MONITOR] Error checking transactions:', error);
        return [];
    }
}
// ============================================================================
// Trading Logic
// ============================================================================
import { getJupiterQuote, getJupiterSwapTransaction } from './solana.js';
import { buildLiquidityProvisioningTransactions } from './meteora-damm.js';
import { buildAtomicLPTransaction, buildAtomicPoolCreationTransaction, submitAtomicTransaction } from './meteora-atomic.js';
async function processIncomingTransaction(tx) {
    console.log(`[PROCESS] Processing tx ${tx.signature} - ${tx.amount / 1e9} SOL from ${tx.sender}`);
    const wallet = getSystemWalletSync();
    if (!wallet) {
        console.error('[PROCESS] No system wallet available');
        return;
    }
    // Record transaction as processing in database
    await insertProcessedIncoming({
        incomingSignature: tx.signature,
        sender: tx.sender,
        amountLamports: BigInt(tx.amount),
        status: 'processing',
    });
    // Calculate amounts - 47.5% per swap (95% total, 5% kept as fee)
    const totalLamports = tx.amount;
    const swapAmount = Math.floor(totalLamports * SWAP_PERCENTAGE); // 47.5% each
    console.log(`[PROCESS] Swapping 2x ${swapAmount / 1e9} SOL (47.5% each = 95% total, 5% fee kept)`);
    // Get trending memecoin
    const trendingToken = await getTopTrendingMemecoin();
    if (!trendingToken) {
        console.error('[PROCESS] No trending token available - cannot create pool with same token on both sides');
        await markForRetry(tx.signature, 'No trending token available from Birdeye');
        return;
    }
    // Ensure we have two different tokens
    if (trendingToken.address === PROOF_V3_MINT) {
        console.error('[PROCESS] Trending token is same as PROOF V3 - cannot create pool');
        await markForRetry(tx.signature, 'Trending token is same as PROOF V3');
        return;
    }
    const tokenAMint = PROOF_V3_MINT;
    const tokenBMint = trendingToken.address;
    console.log(`[PROCESS] Will swap to: ${tokenAMint} (PROOF V3) and ${tokenBMint} (${trendingToken?.symbol || 'PROOF V3'})`);
    try {
        // Step 0: Check if pool exists to determine if we need to reserve SOL for pool creation
        console.log('[PROCESS] Step 0: Checking if pool exists...');
        await updateProcessedIncoming(tx.signature, { currentStep: 'check_pool' });
        const poolInfo = await findPool(tokenAMint, tokenBMint);
        const needsPoolCreation = !poolInfo.exists;
        // Reserve SOL for pool creation rent if needed (~0.03 SOL for safety)
        const POOL_CREATION_RESERVE = needsPoolCreation ? 30_000_000 : 0; // 0.03 SOL
        const availableForSwaps = totalLamports - POOL_CREATION_RESERVE;
        if (availableForSwaps < 5_000_000) { // Need at least 0.005 SOL for swaps
            console.error(`[PROCESS] Not enough SOL after reserving for pool creation. Available: ${availableForSwaps / 1e9} SOL`);
            await markForRetry(tx.signature, `Insufficient SOL: ${availableForSwaps / 1e9} available after pool reserve`);
            return;
        }
        const swapAmountAdjusted = Math.floor(availableForSwaps * SWAP_PERCENTAGE); // 47.5% of available
        console.log(`[PROCESS] Pool exists: ${poolInfo.exists}, Reserved for pool: ${POOL_CREATION_RESERVE / 1e9} SOL`);
        console.log(`[PROCESS] Adjusted swap amount: ${swapAmountAdjusted / 1e9} SOL each (was ${swapAmount / 1e9} SOL)`);
        // Step 1: Swap 47.5% to PROOF V3
        console.log('[PROCESS] Step 1: Swapping 47.5% to PROOF V3...');
        await updateProcessedIncoming(tx.signature, { currentStep: 'swap_proof' });
        const proofQuote = await getJupiterQuote({
            inputMint: WSOL_MINT,
            outputMint: tokenAMint,
            amount: swapAmountAdjusted.toString(),
            slippageBps: 100,
        });
        if (!proofQuote.success) {
            console.error('[PROCESS] Failed to get PROOF V3 quote:', proofQuote.error);
            await markForRetry(tx.signature, `PROOF V3 quote failed: ${proofQuote.error}`);
            return;
        }
        const proofSwapTx = await getJupiterSwapTransaction(proofQuote.quote, wallet.publicKey.toBase58());
        if (!proofSwapTx.success || !proofSwapTx.transaction) {
            console.error('[PROCESS] Failed to get PROOF V3 swap tx:', proofSwapTx.error);
            await markForRetry(tx.signature, `PROOF V3 swap tx failed: ${proofSwapTx.error}`);
            return;
        }
        // Deserialize and sign
        const proofTx = VersionedTransaction.deserialize(Buffer.from(proofSwapTx.transaction, 'base64'));
        proofTx.sign([wallet]);
        // Submit
        const proofSig = await connection.sendTransaction(proofTx, { skipPreflight: true });
        console.log(`[PROCESS] PROOF V3 swap submitted: ${proofSig}`);
        // Wait for confirmation
        await connection.confirmTransaction(proofSig, 'confirmed');
        console.log('[PROCESS] PROOF V3 swap confirmed');
        // Step 2: Swap 47.5% to trending memecoin
        console.log(`[PROCESS] Step 2: Swapping 47.5% to ${trendingToken?.symbol || 'trending token'}...`);
        await updateProcessedIncoming(tx.signature, { currentStep: 'swap_trending' });
        const trendingQuote = await getJupiterQuote({
            inputMint: WSOL_MINT,
            outputMint: tokenBMint,
            amount: swapAmountAdjusted.toString(),
            slippageBps: 100,
        });
        if (!trendingQuote.success) {
            console.error('[PROCESS] Failed to get trending token quote:', trendingQuote.error);
            return;
        }
        const trendingSwapTx = await getJupiterSwapTransaction(trendingQuote.quote, wallet.publicKey.toBase58());
        if (!trendingSwapTx.success || !trendingSwapTx.transaction) {
            console.error('[PROCESS] Failed to get trending swap tx:', trendingSwapTx.error);
            return;
        }
        const trendingTx = VersionedTransaction.deserialize(Buffer.from(trendingSwapTx.transaction, 'base64'));
        trendingTx.sign([wallet]);
        const trendingSig = await connection.sendTransaction(trendingTx, { skipPreflight: true });
        console.log(`[PROCESS] Trending token swap submitted: ${trendingSig}`);
        await connection.confirmTransaction(trendingSig, 'confirmed');
        console.log('[PROCESS] Trending token swap confirmed');
        // Step 3: Create/Add to Meteora DAMM V2 pool with ATOMIC transaction
        // This bundles: Create Position + Add Liquidity + Lock + Transfer NFT in ONE tx
        console.log('[PROCESS] Step 3: Building atomic LP transaction (create+add+lock+transfer)...');
        await updateProcessedIncoming(tx.signature, { currentStep: 'create_pool' });
        // Get token balances after swaps
        const proofBalance = await getTokenBalance(wallet.publicKey, new PublicKey(tokenAMint));
        const trendingBalance = await getTokenBalance(wallet.publicKey, new PublicKey(tokenBMint));
        console.log(`[PROCESS] Token balances - PROOF: ${proofBalance}, Trending: ${trendingBalance}`);
        if (Number(proofBalance) === 0 || Number(trendingBalance) === 0) {
            console.error('[PROCESS] Insufficient token balances after swaps');
            await markForRetry(tx.signature, `Insufficient token balances: PROOF=${proofBalance}, Trending=${trendingBalance}`);
            return;
        }
        // Use poolInfo from Step 0 (already checked)
        let poolAddress;
        if (!poolInfo.exists || !poolInfo.poolAddress) {
            // Need to create pool - use ATOMIC pool creation (create + lock + transfer NFT in one tx)
            console.log('[PROCESS] Pool does not exist, building atomic pool creation transaction...');
            const atomicPoolResult = await buildAtomicPoolCreationTransaction(tokenAMint, tokenBMint, proofBalance.toString(), trendingBalance.toString(), wallet, tx.sender // Recipient of the NFT = sender of SOL
            );
            if (!atomicPoolResult.success || !atomicPoolResult.transaction) {
                console.error('[PROCESS] Failed to build atomic pool creation transaction:', atomicPoolResult.error);
                await markForRetry(tx.signature, `Atomic pool creation failed: ${atomicPoolResult.error}`);
                return;
            }
            console.log(`[PROCESS] Atomic pool tx built - Pool: ${atomicPoolResult.poolAddress}, Position: ${atomicPoolResult.positionAddress}, NFT: ${atomicPoolResult.positionNftMint}`);
            // Submit the atomic transaction
            const submitResult = await submitAtomicTransaction(atomicPoolResult.transaction);
            if (!submitResult.success) {
                console.error('[PROCESS] Atomic pool creation transaction failed:', submitResult.error);
                await markForRetry(tx.signature, `Atomic pool tx failed: ${submitResult.error}`);
                return;
            }
            console.log(`[PROCESS] ✅ Atomic pool creation confirmed: ${submitResult.signature}`);
            console.log(`[PROCESS] Pool created, locked, and NFT transferred to ${tx.sender}`);
            // Update database with success
            await updateProcessedIncoming(tx.signature, {
                status: 'completed',
                trendingTokenMint: tokenBMint,
                trendingTokenSymbol: trendingToken?.symbol || 'PROOF',
                poolAddress: atomicPoolResult.poolAddress || undefined,
                positionAddress: atomicPoolResult.positionAddress || undefined,
                positionNftMint: atomicPoolResult.positionNftMint || undefined,
                isNewPool: true,
                completedAt: new Date(),
            });
            console.log(`[PROCESS] ✅ Completed (new pool - atomic) tx ${tx.signature}`);
            return;
        }
        poolAddress = poolInfo.poolAddress;
        console.log(`[PROCESS] Pool exists: ${poolAddress}`);
        // Build atomic transaction: Create Position + Add Liquidity + Lock + Transfer NFT
        const atomicResult = await buildAtomicLPTransaction(poolAddress, tokenAMint, tokenBMint, proofBalance.toString(), trendingBalance.toString(), wallet, tx.sender, // Recipient of the NFT
        5000 // 50% slippage for LP
        );
        if (!atomicResult.success || !atomicResult.transaction) {
            console.error('[PROCESS] Failed to build atomic LP transaction:', atomicResult.error);
            await markForRetry(tx.signature, `Atomic LP failed: ${atomicResult.error}`);
            return;
        }
        console.log(`[PROCESS] Atomic tx built - Position: ${atomicResult.positionAddress}, NFT: ${atomicResult.positionNftMint}`);
        // Submit the atomic transaction
        const submitResult = await submitAtomicTransaction(atomicResult.transaction);
        if (!submitResult.success) {
            console.error('[PROCESS] Atomic transaction failed:', submitResult.error);
            await markForRetry(tx.signature, `Atomic tx failed: ${submitResult.error}`);
            return;
        }
        console.log(`[PROCESS] ✅ Atomic transaction confirmed: ${submitResult.signature}`);
        console.log(`[PROCESS] Position created, locked, and NFT transferred to ${tx.sender}`);
        // Update database with success
        await updateProcessedIncoming(tx.signature, {
            status: 'completed',
            trendingTokenMint: tokenBMint,
            trendingTokenSymbol: trendingToken?.symbol || 'PROOF',
            poolAddress: poolAddress,
            positionAddress: atomicResult.positionAddress || undefined,
            positionNftMint: atomicResult.positionNftMint || undefined,
            isNewPool: false,
            completedAt: new Date(),
        });
        console.log(`[PROCESS] ✅ Completed processing tx ${tx.signature}`);
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[PROCESS] Error processing transaction:', errorMsg);
        // Mark for retry with exponential backoff
        await markForRetry(tx.signature, errorMsg);
        console.log(`[PROCESS] Transaction ${tx.signature} marked for retry`);
    }
}
async function getTokenBalance(owner, mint) {
    // Try regular SPL Token first
    try {
        const ata = await getAssociatedTokenAddress(mint, owner);
        const balance = await connection.getTokenAccountBalance(ata);
        if (BigInt(balance.value.amount) > BigInt(0)) {
            return BigInt(balance.value.amount);
        }
    }
    catch {
        // Continue to try Token-2022
    }
    // Try Token-2022
    try {
        const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_2022_PROGRAM_ID);
        const balance = await connection.getTokenAccountBalance(ata);
        return BigInt(balance.value.amount);
    }
    catch {
        return BigInt(0);
    }
}
async function transferPositionNft(wallet, positionNftMint, recipient) {
    const mintPubkey = new PublicKey(positionNftMint);
    const recipientPubkey = new PublicKey(recipient);
    // Position NFTs use Token-2022 program
    const sourceAta = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const destAta = await getAssociatedTokenAddress(mintPubkey, recipientPubkey, false, TOKEN_2022_PROGRAM_ID);
    // Build instructions array
    const instructions = [];
    // Check if destination ATA exists, create if not
    const destAtaInfo = await connection.getAccountInfo(destAta);
    if (!destAtaInfo) {
        console.log('[TRANSFER] Creating destination ATA for recipient...');
        const createAtaIx = createAssociatedTokenAccountInstruction(wallet.publicKey, // payer
        destAta, recipientPubkey, mintPubkey, TOKEN_2022_PROGRAM_ID);
        instructions.push(createAtaIx);
    }
    // Build transfer instruction
    const transferIx = createTransferInstruction(sourceAta, destAta, wallet.publicKey, 1, // NFT amount is always 1
    [], TOKEN_2022_PROGRAM_ID);
    instructions.push(transferIx);
    // Build transaction
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([wallet]);
    const sig = await connection.sendTransaction(tx, { skipPreflight: true });
    await connection.confirmTransaction(sig, 'confirmed');
    console.log(`[TRANSFER] LP NFT transferred successfully: ${sig}`);
    return sig;
}
// ============================================================================
// Retry Queue Processing
// ============================================================================
async function processRetryQueue() {
    try {
        const retryTransactions = await getTransactionsForRetry(5);
        if (retryTransactions.length === 0)
            return;
        console.log(`[RETRY] Found ${retryTransactions.length} transactions to retry`);
        for (const record of retryTransactions) {
            // Check if it's time to retry (based on nextRetryAt)
            if (record.nextRetryAt && new Date(record.nextRetryAt) > new Date()) {
                continue; // Not time yet
            }
            console.log(`[RETRY] Retrying transaction ${record.incomingSignature} (attempt ${(record.retryCount || 0) + 1})`);
            // Convert database record to IncomingTransaction format
            const tx = {
                signature: record.incomingSignature,
                sender: record.sender,
                amount: Number(record.amountLamports),
                slot: 0, // Not needed for retry
                blockTime: record.createdAt ? Math.floor(new Date(record.createdAt).getTime() / 1000) : Math.floor(Date.now() / 1000),
            };
            // Update status to processing
            await updateProcessedIncoming(record.incomingSignature, {
                status: 'processing',
            });
            // Process the transaction (will mark for retry again if it fails)
            await processIncomingTransactionRetry(tx, record.currentStep || 'swap_proof');
        }
    }
    catch (error) {
        console.error('[RETRY] Error processing retry queue:', error);
    }
}
/**
 * Process a transaction that's being retried - can resume from a specific step
 */
async function processIncomingTransactionRetry(tx, startStep) {
    console.log(`[RETRY] Processing tx ${tx.signature} from step: ${startStep}`);
    const wallet = getSystemWalletSync();
    if (!wallet) {
        console.error('[RETRY] No system wallet available');
        await markForRetry(tx.signature, 'No system wallet available');
        return;
    }
    // Get the record to access stored token info
    const record = await getProcessedIncomingBySignature(tx.signature);
    // Get trending token - use stored one if available for consistency
    let tokenBMint = record?.trendingTokenMint;
    let trendingSymbol = record?.trendingTokenSymbol || 'trending';
    if (!tokenBMint) {
        const trendingToken = await getTopTrendingMemecoin();
        if (!trendingToken) {
            console.error('[RETRY] No trending token available');
            await markForRetry(tx.signature, 'No trending token available from Birdeye');
            return;
        }
        if (trendingToken.address === PROOF_V3_MINT) {
            console.error('[RETRY] Trending token is same as PROOF V3');
            await markForRetry(tx.signature, 'Trending token is same as PROOF V3');
            return;
        }
        tokenBMint = trendingToken.address;
        trendingSymbol = trendingToken.symbol;
        // Store for future retries
        await updateProcessedIncoming(tx.signature, {
            trendingTokenMint: tokenBMint,
            trendingTokenSymbol: trendingSymbol,
        });
    }
    const tokenAMint = PROOF_V3_MINT;
    // Define step order for comparison
    const stepOrder = ['check_pool', 'swap_proof', 'swap_trending', 'create_pool', 'lock_lp', 'transfer_nft', 'done'];
    const startIndex = stepOrder.indexOf(startStep);
    const shouldRunStep = (step) => startIndex <= stepOrder.indexOf(step);
    console.log(`[RETRY] Starting from step ${startStep} (index ${startIndex}), tokens: PROOF V3 + ${trendingSymbol}`);
    try {
        // ========== STEP 1: Swap to PROOF V3 ==========
        if (shouldRunStep('swap_proof')) {
            const solBalance = await connection.getBalance(wallet.publicKey);
            console.log(`[RETRY] SOL balance: ${solBalance / 1e9} SOL`);
            if (solBalance >= 5_000_000) {
                const poolInfo = await findPool(tokenAMint, tokenBMint);
                const needsPoolCreation = !poolInfo.exists;
                const POOL_CREATION_RESERVE = needsPoolCreation ? 30_000_000 : 0;
                const availableForSwaps = solBalance - POOL_CREATION_RESERVE - 5_000_000;
                if (availableForSwaps > 1_000_000) {
                    const swapAmount = Math.floor(availableForSwaps * SWAP_PERCENTAGE);
                    console.log(`[RETRY] Step 1: Swapping ${swapAmount / 1e9} SOL to PROOF V3...`);
                    await updateProcessedIncoming(tx.signature, { currentStep: 'swap_proof' });
                    const proofQuote = await getJupiterQuote({
                        inputMint: WSOL_MINT,
                        outputMint: tokenAMint,
                        amount: swapAmount.toString(),
                        slippageBps: 100,
                    });
                    if (!proofQuote.success)
                        throw new Error(`PROOF V3 quote failed: ${proofQuote.error}`);
                    const proofSwapTx = await getJupiterSwapTransaction(proofQuote.quote, wallet.publicKey.toBase58());
                    if (!proofSwapTx.success || !proofSwapTx.transaction)
                        throw new Error(`PROOF V3 swap tx failed: ${proofSwapTx.error}`);
                    const proofTx = VersionedTransaction.deserialize(Buffer.from(proofSwapTx.transaction, 'base64'));
                    proofTx.sign([wallet]);
                    const proofSig = await connection.sendTransaction(proofTx, { skipPreflight: true });
                    await connection.confirmTransaction(proofSig, 'confirmed');
                    console.log(`[RETRY] PROOF V3 swap confirmed: ${proofSig}`);
                    await updateProcessedIncoming(tx.signature, { proofSwapSignature: proofSig });
                }
                else {
                    console.log(`[RETRY] Skipping swap_proof - not enough SOL after reserves`);
                }
            }
            else {
                console.log(`[RETRY] Skipping swap_proof - insufficient SOL`);
            }
        }
        else {
            console.log(`[RETRY] Skipping swap_proof - already completed`);
        }
        // ========== STEP 2: Swap to trending token ==========
        if (shouldRunStep('swap_trending')) {
            const solBalance = await connection.getBalance(wallet.publicKey);
            if (solBalance >= 5_000_000) {
                const poolInfo = await findPool(tokenAMint, tokenBMint);
                const needsPoolCreation = !poolInfo.exists;
                const POOL_CREATION_RESERVE = needsPoolCreation ? 30_000_000 : 0;
                const availableForSwaps = solBalance - POOL_CREATION_RESERVE - 5_000_000;
                if (availableForSwaps > 1_000_000) {
                    const swapAmount = Math.floor(availableForSwaps * SWAP_PERCENTAGE);
                    console.log(`[RETRY] Step 2: Swapping ${swapAmount / 1e9} SOL to ${trendingSymbol}...`);
                    await updateProcessedIncoming(tx.signature, { currentStep: 'swap_trending' });
                    const trendingQuote = await getJupiterQuote({
                        inputMint: WSOL_MINT,
                        outputMint: tokenBMint,
                        amount: swapAmount.toString(),
                        slippageBps: 100,
                    });
                    if (!trendingQuote.success)
                        throw new Error(`Trending quote failed: ${trendingQuote.error}`);
                    const trendingSwapTx = await getJupiterSwapTransaction(trendingQuote.quote, wallet.publicKey.toBase58());
                    if (!trendingSwapTx.success || !trendingSwapTx.transaction)
                        throw new Error(`Trending swap tx failed: ${trendingSwapTx.error}`);
                    const trendingTx = VersionedTransaction.deserialize(Buffer.from(trendingSwapTx.transaction, 'base64'));
                    trendingTx.sign([wallet]);
                    const trendingSig = await connection.sendTransaction(trendingTx, { skipPreflight: true });
                    await connection.confirmTransaction(trendingSig, 'confirmed');
                    console.log(`[RETRY] Trending swap confirmed: ${trendingSig}`);
                    await updateProcessedIncoming(tx.signature, {
                        trendingSwapSignature: trendingSig,
                        trendingTokenMint: tokenBMint,
                        trendingTokenSymbol: trendingSymbol,
                    });
                }
                else {
                    console.log(`[RETRY] Skipping swap_trending - not enough SOL after reserves`);
                }
            }
            else {
                console.log(`[RETRY] Skipping swap_trending - insufficient SOL`);
            }
        }
        else {
            console.log(`[RETRY] Skipping swap_trending - already completed`);
        }
        // ========== STEP 3: Create/add to pool ==========
        if (shouldRunStep('create_pool')) {
            console.log('[RETRY] Step 3: Creating/adding to pool...');
            await updateProcessedIncoming(tx.signature, { currentStep: 'create_pool' });
            const proofBalance = await getTokenBalance(wallet.publicKey, new PublicKey(tokenAMint));
            const trendingBalance = await getTokenBalance(wallet.publicKey, new PublicKey(tokenBMint));
            console.log(`[RETRY] Token balances - PROOF: ${proofBalance}, ${trendingSymbol}: ${trendingBalance}`);
            if (Number(proofBalance) === 0 || Number(trendingBalance) === 0) {
                throw new Error(`Insufficient token balances: PROOF=${proofBalance}, ${trendingSymbol}=${trendingBalance}`);
            }
            const lpResult = await buildLiquidityProvisioningTransactions(tokenAMint, tokenBMint, proofBalance.toString(), trendingBalance.toString(), wallet.publicKey.toBase58(), true, undefined);
            if (!lpResult.success || lpResult.transactions.length === 0) {
                throw new Error(`LP transactions failed: ${lpResult.error}`);
            }
            console.log(`[RETRY] Got ${lpResult.transactions.length} LP transactions`);
            for (let i = 0; i < lpResult.transactions.length; i++) {
                const txBase64 = lpResult.transactions[i];
                const lpTx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
                lpTx.sign([wallet]);
                const sig = await connection.sendTransaction(lpTx, { skipPreflight: true });
                await connection.confirmTransaction(sig, 'confirmed');
                console.log(`[RETRY] LP tx ${i + 1}/${lpResult.transactions.length} confirmed: ${sig}`);
            }
            await updateProcessedIncoming(tx.signature, {
                poolAddress: lpResult.poolAddress || undefined,
                positionAddress: lpResult.positionAddress || undefined,
                positionNftMint: lpResult.positionNftMint || undefined,
                isNewPool: lpResult.isNewPool,
            });
        }
        else {
            console.log(`[RETRY] Skipping create_pool - already completed`);
        }
        // ========== STEP 4: Transfer NFT to sender ==========
        if (shouldRunStep('transfer_nft')) {
            console.log('[RETRY] Step 4: Transferring NFT to sender...');
            await updateProcessedIncoming(tx.signature, { currentStep: 'transfer_nft' });
            const updatedRecord = await getProcessedIncomingBySignature(tx.signature);
            const positionNftMint = updatedRecord?.positionNftMint;
            if (positionNftMint) {
                const transferSig = await transferPositionNft(wallet, positionNftMint, tx.sender);
                console.log(`[RETRY] NFT transferred: ${transferSig}`);
                await updateProcessedIncoming(tx.signature, { nftTransferSignature: transferSig });
            }
            else {
                console.log('[RETRY] No position NFT mint found - skipping transfer');
            }
        }
        else {
            console.log(`[RETRY] Skipping transfer_nft - already completed`);
        }
        // Mark as completed
        await updateProcessedIncoming(tx.signature, {
            status: 'completed',
            currentStep: 'done',
            completedAt: new Date(),
        });
        console.log(`[RETRY] ✅ Successfully completed tx ${tx.signature}`);
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[RETRY] Error processing tx ${tx.signature}:`, errorMsg);
        await markForRetry(tx.signature, errorMsg);
    }
}
// ============================================================================
// Monitoring Loop
// ============================================================================
let isMonitoring = false;
let monitoringInterval = null;
export async function startMonitoring() {
    if (isMonitoring) {
        console.log('[MONITOR] Already monitoring');
        return;
    }
    // Initialize wallet
    await getOrCreateSystemWallet();
    isMonitoring = true;
    console.log('[MONITOR] Starting transaction monitoring...');
    console.log(`[MONITOR] System wallet: ${systemWallet?.publicKey.toBase58()}`);
    console.log('[MONITOR] Polling every 10 seconds');
    // Poll every 10 seconds
    monitoringInterval = setInterval(async () => {
        try {
            // Check for new incoming transactions
            const transactions = await checkForIncomingTransactions();
            for (const tx of transactions) {
                await processIncomingTransaction(tx);
            }
            // Check for transactions that need retry
            await processRetryQueue();
        }
        catch (error) {
            console.error('[MONITOR] Error in monitoring loop:', error);
        }
    }, 10000);
    // Also check immediately
    const transactions = await checkForIncomingTransactions();
    for (const tx of transactions) {
        await processIncomingTransaction(tx);
    }
    // Process any pending retries
    await processRetryQueue();
}
export function stopMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
    isMonitoring = false;
    console.log('[MONITOR] Stopped monitoring');
}
export function getMonitoringStatus() {
    return {
        isMonitoring,
        systemWallet: systemWallet?.publicKey.toBase58() || null,
        processedCount: processedSignatures.size,
        cachedTrendingToken,
    };
}
// Export for use in routers
export { getTopTrendingMemecoin, getOrCreateSystemWallet };
// Main entry point for Railway deployment
export async function startAutoTrader() {
    console.log('='.repeat(60));
    console.log('Liquidity Monster Auto-Trader Starting...');
    console.log('='.repeat(60));
    await startMonitoring();
    // Keep the process running
    console.log('[AUTO-TRADER] Running continuously. Press Ctrl+C to stop.');
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[AUTO-TRADER] Received SIGINT, shutting down...');
        stopMonitoring();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        console.log('\n[AUTO-TRADER] Received SIGTERM, shutting down...');
        stopMonitoring();
        process.exit(0);
    });
}
//# sourceMappingURL=auto-trader.js.map