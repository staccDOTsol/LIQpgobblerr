/**
 * Automated Trading & Liquidity System
 * 
 * Monitors incoming SOL transactions, swaps into PROOF V3 + trending memecoin,
 * creates/adds to Meteora DAMM V2 pools, locks liquidity, and sends LP NFT to sender.
 * 
 * Standalone version for Railway deployment.
 */

import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { isTransactionProcessed, insertProcessedIncoming, updateProcessedIncoming, getProcessedIncomingBySignature, markForRetry, getTransactionsForRetry } from './db.js';
import { findPool, buildLiquidityProvisioningTransactions } from './meteora-damm.js';
import { buildAtomicLPTransaction, buildAtomicPoolCreationTransaction, submitAtomicTransaction } from './meteora-atomic.js';
import { getJupiterQuote, getJupiterSwapTransaction } from './solana.js';

// Constants
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '0d4b4fd6-c2fc-4f55-b615-a23bab1ffc85';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || 'eeb246144fc1461d9036b52e1bbf5cf3';
const BIRDEYE_API_URL = 'https://public-api.birdeye.so';
const PROOF_V3_MINT = 'CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const MIN_SOL_LAMPORTS = 10_000_000; // 0.01 SOL minimum
const SWAP_PERCENTAGE = 0.475; // 47.5% per swap (95% total, 5% kept as fee)

// Connection
const connection = new Connection(HELIUS_RPC_URL, 'confirmed');

// ============================================================================
// Birdeye Trending Token Cache (1 second TTL)
// ============================================================================

interface TrendingToken {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
}

let cachedTrendingToken: TrendingToken | null = null;
let lastTrendingFetch = 0;
const TRENDING_CACHE_TTL_MS = 1000;

async function getTopTrendingMemecoin(): Promise<TrendingToken | null> {
  const now = Date.now();
  
  if (cachedTrendingToken && (now - lastTrendingFetch) < TRENDING_CACHE_TTL_MS) {
    return cachedTrendingToken;
  }
  
  try {
    const response = await fetch(`${BIRDEYE_API_URL}/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=10`, {
      headers: {
        'X-API-KEY': BIRDEYE_API_KEY,
        'x-chain': 'solana',
      },
    });
    
    if (!response.ok) {
      console.error('[BIRDEYE] Failed to fetch trending tokens:', response.status);
      return cachedTrendingToken;
    }
    
    const data = await response.json();
    console.log('[BIRDEYE] API response:', JSON.stringify(data).substring(0, 500));
    
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
  } catch (error) {
    console.error('[BIRDEYE] Error fetching trending tokens:', error);
    return cachedTrendingToken;
  }
}

// ============================================================================
// System Wallet Management
// ============================================================================

let systemWallet: Keypair | null = null;

async function getOrCreateSystemWallet(): Promise<Keypair> {
  if (systemWallet) {
    return systemWallet;
  }
  
  // Load from environment variable (required for Railway)
  const privateKey = process.env.SYSTEM_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('SYSTEM_WALLET_PRIVATE_KEY environment variable is required');
  }
  
  try {
    systemWallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    console.log(`[WALLET] Loaded system wallet: ${systemWallet.publicKey.toBase58()}`);
    return systemWallet;
  } catch (error) {
    throw new Error(`Invalid SYSTEM_WALLET_PRIVATE_KEY: ${error}`);
  }
}

function getSystemWalletSync(): Keypair | null {
  return systemWallet;
}

// ============================================================================
// Transaction Monitoring
// ============================================================================

interface IncomingTransaction {
  signature: string;
  sender: string;
  amount: number;
  slot: number;
  blockTime: number;
}

let processedSignatures = new Set<string>();

async function checkForIncomingTransactions(): Promise<IncomingTransaction[]> {
  const wallet = getSystemWalletSync();
  if (!wallet) {
    return [];
  }
  
  try {
    const signatures = await connection.getSignaturesForAddress(
      wallet.publicKey,
      { limit: 20 },
      'confirmed'
    );
    
    const newTransactions: IncomingTransaction[] = [];
    
    for (const sig of signatures) {
      if (processedSignatures.has(sig.signature)) {
        continue;
      }
      
      const alreadyProcessed = await isTransactionProcessed(sig.signature);
      if (alreadyProcessed) {
        processedSignatures.add(sig.signature);
        continue;
      }
      
      const tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });
      
      if (!tx || !tx.meta) continue;
      
      const preBalances = tx.meta.preBalances;
      const postBalances = tx.meta.postBalances;
      
      const message = tx.transaction.message;
      let accountKeys: PublicKey[] = [];
      
      if ('staticAccountKeys' in message) {
        accountKeys = message.staticAccountKeys;
      } else if ('accountKeys' in message) {
        accountKeys = (message as any).accountKeys;
      }
      
      if (accountKeys.length === 0) continue;
      
      let ourIndex = -1;
      for (let i = 0; i < accountKeys.length; i++) {
        if (accountKeys[i]?.equals(wallet.publicKey)) {
          ourIndex = i;
          break;
        }
      }
      
      if (ourIndex === -1) continue;
      
      const balanceChange = postBalances[ourIndex] - preBalances[ourIndex];
      
      if (balanceChange >= MIN_SOL_LAMPORTS) {
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
      } else {
        processedSignatures.add(sig.signature);
      }
    }
    
    return newTransactions;
  } catch (error) {
    console.error('[MONITOR] Error checking transactions:', error);
    return [];
  }
}

// ============================================================================
// Trading Logic
// ============================================================================

async function processIncomingTransaction(tx: IncomingTransaction): Promise<void> {
  console.log(`[PROCESS] Processing tx ${tx.signature} - ${tx.amount / 1e9} SOL from ${tx.sender}`);
  
  const wallet = getSystemWalletSync();
  if (!wallet) {
    console.error('[PROCESS] No system wallet available');
    return;
  }
  
  await insertProcessedIncoming({
    incomingSignature: tx.signature,
    senderAddress: tx.sender,
    amountLamports: tx.amount.toString(),
    status: 'processing',
  });
  
  try {
    // Get trending token
    const trendingToken = await getTopTrendingMemecoin();
    if (!trendingToken) {
      console.error('[PROCESS] No trending token available');
      await markForRetry(tx.signature, 'No trending token available from Birdeye');
      return;
    }
    
    if (trendingToken.address === PROOF_V3_MINT) {
      console.error('[PROCESS] Trending token is same as PROOF V3, skipping');
      await markForRetry(tx.signature, 'Trending token is same as PROOF V3');
      return;
    }
    
    console.log(`[PROCESS] Using trending token: ${trendingToken.symbol} (${trendingToken.address})`);
    
    const tokenAMint = PROOF_V3_MINT;
    const tokenBMint = trendingToken.address;
    
    // Check if pool exists
    const poolInfo = await findPool(tokenAMint, tokenBMint);
    const needsPoolCreation = !poolInfo.exists;
    
    console.log(`[PROCESS] Pool exists: ${poolInfo.exists}, address: ${poolInfo.poolAddress}`);
    
    // Calculate swap amounts
    const POOL_CREATION_RESERVE = needsPoolCreation ? 30_000_000 : 0;
    const solBalance = await connection.getBalance(wallet.publicKey);
    const availableForSwaps = solBalance - POOL_CREATION_RESERVE - 5_000_000;
    
    if (availableForSwaps < 1_000_000) {
      console.error('[PROCESS] Insufficient SOL for swaps');
      await markForRetry(tx.signature, 'Insufficient SOL for swaps');
      return;
    }
    
    const swapAmount = Math.floor(availableForSwaps * SWAP_PERCENTAGE);
    console.log(`[PROCESS] Swap amount: ${swapAmount / 1e9} SOL each`);
    
    // ========== STEP 1: Swap to PROOF V3 ==========
    console.log('[PROCESS] Step 1: Swapping to PROOF V3...');
    await updateProcessedIncoming(tx.signature, { currentStep: 'swap_proof' });
    
    const proofQuote = await getJupiterQuote({
      inputMint: WSOL_MINT,
      outputMint: tokenAMint,
      amount: swapAmount.toString(),
      slippageBps: 100,
    });
    
    if (!proofQuote.success) {
      throw new Error(`PROOF V3 quote failed: ${proofQuote.error}`);
    }
    
    const proofSwapTx = await getJupiterSwapTransaction(proofQuote.quote, wallet.publicKey.toBase58());
    if (!proofSwapTx.success || !proofSwapTx.transaction) {
      throw new Error(`PROOF V3 swap tx failed: ${proofSwapTx.error}`);
    }
    
    const proofTx = VersionedTransaction.deserialize(Buffer.from(proofSwapTx.transaction, 'base64'));
    proofTx.sign([wallet]);
    const proofSig = await connection.sendTransaction(proofTx, { skipPreflight: true });
    await connection.confirmTransaction(proofSig, 'confirmed');
    console.log(`[PROCESS] PROOF V3 swap confirmed: ${proofSig}`);
    await updateProcessedIncoming(tx.signature, { proofSwapSignature: proofSig });
    
    // ========== STEP 2: Swap to trending token ==========
    console.log(`[PROCESS] Step 2: Swapping to ${trendingToken.symbol}...`);
    await updateProcessedIncoming(tx.signature, { currentStep: 'swap_trending' });
    
    const trendingQuote = await getJupiterQuote({
      inputMint: WSOL_MINT,
      outputMint: tokenBMint,
      amount: swapAmount.toString(),
      slippageBps: 100,
    });
    
    if (!trendingQuote.success) {
      throw new Error(`Trending quote failed: ${trendingQuote.error}`);
    }
    
    const trendingSwapTx = await getJupiterSwapTransaction(trendingQuote.quote, wallet.publicKey.toBase58());
    if (!trendingSwapTx.success || !trendingSwapTx.transaction) {
      throw new Error(`Trending swap tx failed: ${trendingSwapTx.error}`);
    }
    
    const trendingTx = VersionedTransaction.deserialize(Buffer.from(trendingSwapTx.transaction, 'base64'));
    trendingTx.sign([wallet]);
    const trendingSig = await connection.sendTransaction(trendingTx, { skipPreflight: true });
    await connection.confirmTransaction(trendingSig, 'confirmed');
    console.log(`[PROCESS] Trending swap confirmed: ${trendingSig}`);
    await updateProcessedIncoming(tx.signature, { 
      trendingSwapSignature: trendingSig,
      trendingTokenMint: tokenBMint,
      trendingTokenSymbol: trendingToken.symbol,
    });
    
    // ========== STEP 3: Get token balances ==========
    const proofBalance = await getTokenBalance(wallet.publicKey, new PublicKey(tokenAMint));
    const trendingBalance = await getTokenBalance(wallet.publicKey, new PublicKey(tokenBMint));
    
    console.log(`[PROCESS] Token balances - PROOF: ${proofBalance}, ${trendingToken.symbol}: ${trendingBalance}`);
    
    if (Number(proofBalance) === 0 || Number(trendingBalance) === 0) {
      throw new Error(`Insufficient token balances: PROOF=${proofBalance}, ${trendingToken.symbol}=${trendingBalance}`);
    }
    
    // ========== STEP 4: Create atomic LP transaction ==========
    console.log('[PROCESS] Step 4: Building atomic LP transaction...');
    await updateProcessedIncoming(tx.signature, { currentStep: 'create_pool' });
    
    let poolAddress = poolInfo.poolAddress;
    let atomicResult;
    
    if (needsPoolCreation) {
      console.log('[PROCESS] Creating new pool with atomic transaction...');
      atomicResult = await buildAtomicPoolCreationTransaction(
        tokenAMint,
        tokenBMint,
        proofBalance.toString(),
        trendingBalance.toString(),
        wallet,
        tx.sender
      );
      poolAddress = atomicResult.poolAddress;
    } else {
      console.log('[PROCESS] Adding to existing pool with atomic transaction...');
      atomicResult = await buildAtomicLPTransaction(
        poolAddress!,
        tokenAMint,
        tokenBMint,
        proofBalance.toString(),
        trendingBalance.toString(),
        wallet,
        tx.sender
      );
    }
    
    if (!atomicResult.success || !atomicResult.transaction) {
      console.error('[PROCESS] Atomic LP transaction build failed:', atomicResult.error);
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
      poolAddress: poolAddress || undefined,
      positionAddress: atomicResult.positionAddress || undefined,
      positionNftMint: atomicResult.positionNftMint || undefined,
      isNewPool: needsPoolCreation,
      completedAt: new Date(),
    });
    
    console.log(`[PROCESS] ✅ Completed processing tx ${tx.signature}`);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[PROCESS] Error processing transaction:', errorMsg);
    await markForRetry(tx.signature, errorMsg);
    console.log(`[PROCESS] Transaction ${tx.signature} marked for retry`);
  }
}

async function getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  try {
    const ata = await getAssociatedTokenAddress(mint, owner);
    const balance = await connection.getTokenAccountBalance(ata);
    if (BigInt(balance.value.amount) > BigInt(0)) {
      return BigInt(balance.value.amount);
    }
  } catch {
    // Continue to try Token-2022
  }
  
  try {
    const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_2022_PROGRAM_ID);
    const balance = await connection.getTokenAccountBalance(ata);
    return BigInt(balance.value.amount);
  } catch {
    return BigInt(0);
  }
}

async function transferPositionNft(
  wallet: Keypair,
  positionNftMint: string,
  recipient: string
): Promise<string> {
  const mintPubkey = new PublicKey(positionNftMint);
  const recipientPubkey = new PublicKey(recipient);
  
  const sourceAta = await getAssociatedTokenAddress(
    mintPubkey,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  
  const destAta = await getAssociatedTokenAddress(
    mintPubkey,
    recipientPubkey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  
  const instructions = [];
  
  const destAtaInfo = await connection.getAccountInfo(destAta);
  if (!destAtaInfo) {
    console.log('[TRANSFER] Creating destination ATA for recipient...');
    const createAtaIx = createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      destAta,
      recipientPubkey,
      mintPubkey,
      TOKEN_2022_PROGRAM_ID
    );
    instructions.push(createAtaIx);
  }
  
  const transferIx = createTransferInstruction(
    sourceAta,
    destAta,
    wallet.publicKey,
    1,
    [],
    TOKEN_2022_PROGRAM_ID
  );
  instructions.push(transferIx);
  
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  
  const txn = new VersionedTransaction(message);
  txn.sign([wallet]);
  
  const sig = await connection.sendTransaction(txn, { skipPreflight: true });
  await connection.confirmTransaction(sig, 'confirmed');
  
  console.log(`[TRANSFER] LP NFT transferred successfully: ${sig}`);
  return sig;
}

// ============================================================================
// Retry Queue Processing
// ============================================================================

async function processRetryQueue(): Promise<void> {
  try {
    const retryTransactions = await getTransactionsForRetry(5);
    
    if (retryTransactions.length === 0) return;
    
    console.log(`[RETRY] Found ${retryTransactions.length} transactions to retry`);
    
    for (const record of retryTransactions) {
      if (record.nextRetryAt && new Date(record.nextRetryAt) > new Date()) {
        continue;
      }
      
      console.log(`[RETRY] Retrying transaction ${record.incomingSignature} (attempt ${(record.retryCount || 0) + 1})`);
      
      const tx: IncomingTransaction = {
        signature: record.incomingSignature,
        sender: record.senderAddress,
        amount: parseInt(record.amountLamports),
        slot: 0,
        blockTime: Math.floor(new Date(record.createdAt).getTime() / 1000),
      };
      
      await updateProcessedIncoming(record.incomingSignature, {
        status: 'processing',
        lastRetryAt: new Date(),
      });
      
      await processIncomingTransaction(tx);
    }
  } catch (error) {
    console.error('[RETRY] Error processing retry queue:', error);
  }
}

// ============================================================================
// Monitoring Loop
// ============================================================================

let isMonitoring = false;
let monitoringInterval: NodeJS.Timeout | null = null;

export async function startMonitoring(): Promise<void> {
  if (isMonitoring) {
    console.log('[MONITOR] Already monitoring');
    return;
  }
  
  await getOrCreateSystemWallet();
  
  isMonitoring = true;
  console.log('[MONITOR] Starting transaction monitoring...');
  console.log(`[MONITOR] System wallet: ${systemWallet?.publicKey.toBase58()}`);
  console.log('[MONITOR] Polling every 10 seconds');
  
  monitoringInterval = setInterval(async () => {
    try {
      const transactions = await checkForIncomingTransactions();
      
      for (const tx of transactions) {
        await processIncomingTransaction(tx);
      }
      
      await processRetryQueue();
    } catch (error) {
      console.error('[MONITOR] Error in monitoring loop:', error);
    }
  }, 10000);
  
  const transactions = await checkForIncomingTransactions();
  for (const tx of transactions) {
    await processIncomingTransaction(tx);
  }
  
  await processRetryQueue();
}

export function stopMonitoring(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  isMonitoring = false;
  console.log('[MONITOR] Stopped monitoring');
}

export function getMonitoringStatus(): {
  isMonitoring: boolean;
  systemWallet: string | null;
  processedCount: number;
  cachedTrendingToken: TrendingToken | null;
} {
  return {
    isMonitoring,
    systemWallet: systemWallet?.publicKey.toBase58() || null,
    processedCount: processedSignatures.size,
    cachedTrendingToken,
  };
}

export { getTopTrendingMemecoin, getOrCreateSystemWallet };
