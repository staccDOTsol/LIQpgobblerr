/**
 * Auto-Trader V2 Flow (Railway-compatible)
 * 
 * Triggered when >= 0.1 SOL is received at the system wallet.
 * 
 * Flow:
 * 1. 1/4 SOL → Jupiter swap to PROOF V3 → SPL burn
 * 2. 1/4 SOL → Jupiter swap to r-freestacc LST → SPL burn
 * 3. 1/8 SOL → Jupiter swap to leading AMM token (top SOL/hr from pool scanner)
 * 4. 1/8 SOL + token → Add liquidity on Raydium Legacy AMM → transfer LP tokens to sender
 * 5. 1/4 SOL reserved for tx fees, ATAs, Jito tips
 * 6. Remove pool from tracker DB after LP creation
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createBurnInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import BN from 'bn.js';
import {
  Raydium,
  TokenAmount,
  toToken,
  Percent,
  type ApiV3PoolInfoStandardItem,
  type AmmV4Keys,
  type AmmV5Keys,
} from '@raydium-io/raydium-sdk-v2';
import { getJupiterQuote, getJupiterSwapTransaction } from './solana.js';
import { computeSolPerHour } from './raydium-tracker.js';
import {
  isTransactionProcessed,
  insertProcessedIncoming,
  updateProcessedIncoming,
  markForRetry,
  deleteTrackedPool,
} from './db.js';
import 'dotenv/config';

// ============================================================================
// Constants
// ============================================================================

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '0d4b4fd6-c2fc-4f55-b615-a23bab1ffc85';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const connection = new Connection(HELIUS_RPC_URL, 'confirmed');

const PROOF_V3_MINT = 'CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av';
const R_FREESTACC_MINT = 'pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const RAYDIUM_AMM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

const MIN_SOL_LAMPORTS_V2 = 100_000_000; // 0.1 SOL minimum for v2 flow

// ============================================================================
// System Wallet (from env var - Railway compatible)
// ============================================================================

let systemWallet: Keypair | null = null;

async function getOrCreateSystemWallet(): Promise<Keypair> {
  if (systemWallet) return systemWallet;

  const privateKey = process.env.SYSTEM_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('SYSTEM_WALLET_PRIVATE_KEY environment variable is not set');
  }

  try {
    systemWallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    console.log(`[V2-WALLET] Loaded system wallet from env: ${systemWallet.publicKey.toBase58()}`);
    return systemWallet;
  } catch (error) {
    throw new Error(`Failed to load wallet from SYSTEM_WALLET_PRIVATE_KEY: ${error}`);
  }
}

function getSystemWalletSync(): Keypair | null {
  return systemWallet;
}

// ============================================================================
// Token Helpers
// ============================================================================

async function getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  try {
    const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID);
    const balance = await connection.getTokenAccountBalance(ata);
    if (BigInt(balance.value.amount) > 0n) {
      return BigInt(balance.value.amount);
    }
  } catch {}

  try {
    const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_2022_PROGRAM_ID);
    const balance = await connection.getTokenAccountBalance(ata);
    return BigInt(balance.value.amount);
  } catch {
    return 0n;
  }
}

async function getTokenProgramId(mint: PublicKey): Promise<PublicKey> {
  try {
    const info = await connection.getAccountInfo(mint);
    if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return TOKEN_2022_PROGRAM_ID;
    }
  } catch {}
  return TOKEN_PROGRAM_ID;
}

// ============================================================================
// Get Leading Pool from Tracker
// ============================================================================

export function getLeadingPool(): { poolAddress: string; tokenMint: string; tokenSymbol: string; solPerHour: number } | null {
  const pools = computeSolPerHour();
  const active = pools.filter(p => p.solPerHour > 0 && p.isActive);
  if (active.length === 0) return null;
  return active[0];
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

let processedSignaturesV2 = new Set<string>();

async function checkForIncomingTransactionsV2(): Promise<IncomingTransaction[]> {
  const wallet = getSystemWalletSync();
  if (!wallet) return [];

  try {
    const signatures = await connection.getSignaturesForAddress(
      wallet.publicKey,
      { limit: 20 },
      'confirmed'
    );

    const newTransactions: IncomingTransaction[] = [];

    for (const sig of signatures) {
      if (processedSignaturesV2.has(sig.signature)) continue;

      const alreadyProcessed = await isTransactionProcessed(sig.signature);
      if (alreadyProcessed) {
        processedSignaturesV2.add(sig.signature);
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

      if (balanceChange >= MIN_SOL_LAMPORTS_V2) {
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
          processedSignaturesV2.add(sig.signature);
          console.log(`[V2-MONITOR] New incoming tx: ${sig.signature} from ${sender} for ${balanceChange / 1e9} SOL`);
        }
      } else {
        processedSignaturesV2.add(sig.signature);
      }
    }

    return newTransactions;
  } catch (error) {
    console.error('[V2-MONITOR] Error checking transactions:', error);
    return [];
  }
}

// ============================================================================
// V2 Processing Flow
// ============================================================================

async function processIncomingTransactionV2(tx: IncomingTransaction): Promise<void> {
  console.log(`[V2-PROCESS] Processing tx ${tx.signature} - ${tx.amount / 1e9} SOL from ${tx.sender}`);

  const wallet = getSystemWalletSync();
  if (!wallet) {
    console.error('[V2-PROCESS] No system wallet available');
    return;
  }

  await insertProcessedIncoming({
    incomingSignature: tx.signature,
    senderAddress: tx.sender,
    amountLamports: tx.amount.toString(),
    status: 'processing',
  });

  const totalLamports = tx.amount;
  const quarterAmount = Math.floor(totalLamports / 4);
  const eighthAmount = Math.floor(totalLamports / 8);

  console.log(`[V2-PROCESS] Allocation: 1/4=${quarterAmount / 1e9} SOL (PROOF), 1/4=${quarterAmount / 1e9} SOL (r-freestacc), 1/8=${eighthAmount / 1e9} SOL (leading token), 1/8=${eighthAmount / 1e9} SOL (LP SOL side), 1/4=${quarterAmount / 1e9} SOL (fees)`);

  const leadingPool = getLeadingPool();
  if (!leadingPool) {
    console.error('[V2-PROCESS] No leading pool available from tracker');
    await markForRetry(tx.signature, 'No leading pool available from tracker');
    return;
  }

  console.log(`[V2-PROCESS] Leading pool: ${leadingPool.tokenSymbol} (${leadingPool.tokenMint}) at ${leadingPool.solPerHour.toFixed(2)} SOL/hr`);
  console.log(`[V2-PROCESS] Pool address: ${leadingPool.poolAddress}`);

  try {
    // ====================================================================
    // Step 1: Swap 1/4 SOL → PROOF V3
    // ====================================================================
    console.log('[V2-PROCESS] Step 1: Swapping 1/4 SOL to PROOF V3...');
    await updateProcessedIncoming(tx.signature, { currentStep: 'swap_proof' });

    const proofQuote = await getJupiterQuote({
      inputMint: WSOL_MINT,
      outputMint: PROOF_V3_MINT,
      amount: quarterAmount.toString(),
      slippageBps: 300,
    });

    if (!proofQuote.success) {
      console.error('[V2-PROCESS] PROOF V3 quote failed:', proofQuote.error);
      await markForRetry(tx.signature, `PROOF V3 quote failed: ${proofQuote.error}`);
      return;
    }

    const proofSwapTx = await getJupiterSwapTransaction(proofQuote.quote, wallet.publicKey.toBase58());
    if (!proofSwapTx.success || !proofSwapTx.transaction) {
      console.error('[V2-PROCESS] PROOF V3 swap tx failed:', proofSwapTx.error);
      await markForRetry(tx.signature, `PROOF V3 swap tx failed: ${proofSwapTx.error}`);
      return;
    }

    const proofTx = VersionedTransaction.deserialize(Buffer.from(proofSwapTx.transaction, 'base64'));
    proofTx.sign([wallet]);
    const proofSig = await connection.sendTransaction(proofTx, { skipPreflight: true });
    console.log(`[V2-PROCESS] PROOF V3 swap submitted: ${proofSig}`);
    await connection.confirmTransaction(proofSig, 'confirmed');
    console.log('[V2-PROCESS] PROOF V3 swap confirmed');

    // ====================================================================
    // Step 2: Swap 1/4 SOL → r-freestacc LST
    // ====================================================================
    console.log('[V2-PROCESS] Step 2: Swapping 1/4 SOL to r-freestacc LST...');
    await updateProcessedIncoming(tx.signature, { currentStep: 'swap_rfreestacc' });

    const rfreeQuote = await getJupiterQuote({
      inputMint: WSOL_MINT,
      outputMint: R_FREESTACC_MINT,
      amount: quarterAmount.toString(),
      slippageBps: 300,
    });

    if (!rfreeQuote.success) {
      console.error('[V2-PROCESS] r-freestacc quote failed:', rfreeQuote.error);
      await markForRetry(tx.signature, `r-freestacc quote failed: ${rfreeQuote.error}`);
      return;
    }

    const rfreeSwapTx = await getJupiterSwapTransaction(rfreeQuote.quote, wallet.publicKey.toBase58());
    if (!rfreeSwapTx.success || !rfreeSwapTx.transaction) {
      console.error('[V2-PROCESS] r-freestacc swap tx failed:', rfreeSwapTx.error);
      await markForRetry(tx.signature, `r-freestacc swap tx failed: ${rfreeSwapTx.error}`);
      return;
    }

    const rfreeTx = VersionedTransaction.deserialize(Buffer.from(rfreeSwapTx.transaction, 'base64'));
    rfreeTx.sign([wallet]);
    const rfreeSig = await connection.sendTransaction(rfreeTx, { skipPreflight: true });
    console.log(`[V2-PROCESS] r-freestacc swap submitted: ${rfreeSig}`);
    await connection.confirmTransaction(rfreeSig, 'confirmed');
    console.log('[V2-PROCESS] r-freestacc swap confirmed');

    // ====================================================================
    // Step 3: Swap 1/8 SOL → Leading AMM token
    // ====================================================================
    console.log(`[V2-PROCESS] Step 3: Swapping 1/8 SOL to ${leadingPool.tokenSymbol}...`);
    await updateProcessedIncoming(tx.signature, { currentStep: 'swap_leading' });

    const leadingQuote = await getJupiterQuote({
      inputMint: WSOL_MINT,
      outputMint: leadingPool.tokenMint,
      amount: eighthAmount.toString(),
      slippageBps: 500,
    });

    if (!leadingQuote.success) {
      console.error('[V2-PROCESS] Leading token quote failed:', leadingQuote.error);
      await markForRetry(tx.signature, `Leading token quote failed: ${leadingQuote.error}`);
      return;
    }

    const leadingSwapTx = await getJupiterSwapTransaction(leadingQuote.quote, wallet.publicKey.toBase58());
    if (!leadingSwapTx.success || !leadingSwapTx.transaction) {
      console.error('[V2-PROCESS] Leading token swap tx failed:', leadingSwapTx.error);
      await markForRetry(tx.signature, `Leading token swap tx failed: ${leadingSwapTx.error}`);
      return;
    }

    const leadingTx = VersionedTransaction.deserialize(Buffer.from(leadingSwapTx.transaction, 'base64'));
    leadingTx.sign([wallet]);
    const leadingSig = await connection.sendTransaction(leadingTx, { skipPreflight: true });
    console.log(`[V2-PROCESS] Leading token swap submitted: ${leadingSig}`);
    await connection.confirmTransaction(leadingSig, 'confirmed');
    console.log('[V2-PROCESS] Leading token swap confirmed');

    // ====================================================================
    // Step 4: Add Liquidity on Raydium Legacy AMM + Transfer LP to sender
    // ====================================================================
    console.log('[V2-PROCESS] Step 4: Adding liquidity on Raydium AMM...');
    await updateProcessedIncoming(tx.signature, { currentStep: 'add_liquidity' });

    const leadingTokenBalance = await getTokenBalance(wallet.publicKey, new PublicKey(leadingPool.tokenMint));
    console.log(`[V2-PROCESS] Leading token balance: ${leadingTokenBalance}`);

    if (leadingTokenBalance === 0n) {
      console.error('[V2-PROCESS] No leading token balance after swap');
      await markForRetry(tx.signature, 'No leading token balance after swap');
      return;
    }

    const raydium = await Raydium.load({
      connection,
      owner: wallet,
      disableLoadToken: true,
    });

    let poolInfo: ApiV3PoolInfoStandardItem;
    let poolKeys: AmmV4Keys | AmmV5Keys | undefined;

    try {
      const poolData = await raydium.api.fetchPoolById({ ids: leadingPool.poolAddress });
      poolInfo = poolData[0] as ApiV3PoolInfoStandardItem;
      
      if (!poolInfo) {
        throw new Error('Pool not found in Raydium API');
      }
      
      console.log(`[V2-PROCESS] Pool info fetched: ${poolInfo.id}`);
    } catch (apiError) {
      console.error('[V2-PROCESS] Failed to fetch pool from Raydium API, trying RPC fallback...');
      
      try {
        const rpcData = await raydium.liquidity.getPoolInfoFromRpc({ poolId: leadingPool.poolAddress });
        poolInfo = rpcData.poolInfo;
        poolKeys = rpcData.poolKeys;
        console.log(`[V2-PROCESS] Pool info fetched via RPC: ${poolInfo.id}`);
      } catch (rpcError) {
        console.error('[V2-PROCESS] Failed to fetch pool info:', rpcError);
        await markForRetry(tx.signature, `Failed to fetch pool info: ${rpcError}`);
        return;
      }
    }

    const isMintABase = poolInfo.mintA.address === WSOL_MINT;
    const solAmount = eighthAmount;

    const inputAmount = new BN(isMintABase ? solAmount : leadingTokenBalance.toString());
    
    const computeResult = raydium.liquidity.computePairAmount({
      poolInfo,
      amount: inputAmount.toString(),
      baseIn: isMintABase,
      slippage: new Percent(5, 100),
    });

    console.log(`[V2-PROCESS] Computed pair: A=${computeResult.maxAnotherAmount.toExact()}, min=${computeResult.minAnotherAmount.toExact()}`);

    const { execute: executeLiquidity } = await raydium.liquidity.addLiquidity({
      poolInfo,
      poolKeys,
      amountInA: new TokenAmount(
        toToken(poolInfo.mintA),
        isMintABase ? new BN(solAmount) : new BN(leadingTokenBalance.toString()),
      ),
      amountInB: new TokenAmount(
        toToken(poolInfo.mintB),
        isMintABase ? new BN(leadingTokenBalance.toString()) : new BN(solAmount),
      ),
      otherAmountMin: new TokenAmount(
        toToken(isMintABase ? poolInfo.mintB : poolInfo.mintA),
        computeResult.minAnotherAmount.raw,
      ),
      fixedSide: isMintABase ? 'a' : 'b',
    });

    const { txId: lpTxId } = await executeLiquidity({ sendAndConfirm: true });
    console.log(`[V2-PROCESS] Add liquidity confirmed: ${lpTxId}`);

    // ====================================================================
    // Step 5: Burn PROOF V3 and r-freestacc tokens
    // ====================================================================
    console.log('[V2-PROCESS] Step 5: Burning PROOF V3 and r-freestacc tokens...');
    await updateProcessedIncoming(tx.signature, { currentStep: 'burn_tokens' });

    const burnInstructions: TransactionInstruction[] = [];

    const proofMint = new PublicKey(PROOF_V3_MINT);
    const proofProgram = await getTokenProgramId(proofMint);
    const proofBalance = await getTokenBalance(wallet.publicKey, proofMint);
    
    if (proofBalance > 0n) {
      const proofAta = await getAssociatedTokenAddress(proofMint, wallet.publicKey, false, proofProgram);
      burnInstructions.push(
        createBurnInstruction(proofAta, proofMint, wallet.publicKey, proofBalance, [], proofProgram)
      );
      console.log(`[V2-PROCESS] Will burn ${proofBalance} PROOF V3`);
    }

    const rfreeMint = new PublicKey(R_FREESTACC_MINT);
    const rfreeProgram = await getTokenProgramId(rfreeMint);
    const rfreeBalance = await getTokenBalance(wallet.publicKey, rfreeMint);
    
    if (rfreeBalance > 0n) {
      const rfreeAta = await getAssociatedTokenAddress(rfreeMint, wallet.publicKey, false, rfreeProgram);
      burnInstructions.push(
        createBurnInstruction(rfreeAta, rfreeMint, wallet.publicKey, rfreeBalance, [], rfreeProgram)
      );
      console.log(`[V2-PROCESS] Will burn ${rfreeBalance} r-freestacc`);
    }

    // ====================================================================
    // Step 6: Transfer LP tokens to sender
    // ====================================================================
    console.log('[V2-PROCESS] Step 6: Transferring LP tokens to sender...');
    await updateProcessedIncoming(tx.signature, { currentStep: 'transfer_lp' });

    const lpMint = new PublicKey(poolInfo.lpMint.address);
    const lpProgram = await getTokenProgramId(lpMint);
    const lpBalance = await getTokenBalance(wallet.publicKey, lpMint);
    
    console.log(`[V2-PROCESS] LP token balance: ${lpBalance}`);

    if (lpBalance > 0n) {
      const senderPubkey = new PublicKey(tx.sender);
      const sourceLpAta = await getAssociatedTokenAddress(lpMint, wallet.publicKey, false, lpProgram);
      const destLpAta = await getAssociatedTokenAddress(lpMint, senderPubkey, false, lpProgram);

      const destLpAtaInfo = await connection.getAccountInfo(destLpAta);
      if (!destLpAtaInfo) {
        burnInstructions.push(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            destLpAta,
            senderPubkey,
            lpMint,
            lpProgram,
          )
        );
      }

      burnInstructions.push(
        createTransferInstruction(sourceLpAta, destLpAta, wallet.publicKey, lpBalance, [], lpProgram)
      );
      console.log(`[V2-PROCESS] Will transfer ${lpBalance} LP tokens to ${tx.sender}`);
    }

    // Execute burn + transfer in one transaction
    if (burnInstructions.length > 0) {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: burnInstructions,
      }).compileToV0Message();

      const burnTransferTx = new VersionedTransaction(message);
      burnTransferTx.sign([wallet]);

      const burnSig = await connection.sendTransaction(burnTransferTx, { skipPreflight: true });
      console.log(`[V2-PROCESS] Burn + LP transfer submitted: ${burnSig}`);
      await connection.confirmTransaction(burnSig, 'confirmed');
      console.log('[V2-PROCESS] Burn + LP transfer confirmed');
    }

    // ====================================================================
    // Step 7: Remove pool from tracker DB
    // ====================================================================
    console.log('[V2-PROCESS] Step 7: Removing pool from tracker DB...');
    try {
      await deleteTrackedPool(leadingPool.poolAddress);
      console.log(`[V2-PROCESS] Pool ${leadingPool.poolAddress} removed from tracker`);
    } catch (error) {
      console.warn('[V2-PROCESS] Failed to remove pool from tracker (non-critical):', error);
    }

    // ====================================================================
    // Done!
    // ====================================================================
    await updateProcessedIncoming(tx.signature, {
      status: 'completed',
      trendingTokenMint: leadingPool.tokenMint,
      trendingTokenSymbol: leadingPool.tokenSymbol,
      poolAddress: leadingPool.poolAddress,
      isNewPool: false,
      completedAt: new Date(),
    });

    console.log(`[V2-PROCESS] ✅ Completed V2 flow for tx ${tx.signature}`);
    console.log(`[V2-PROCESS] Summary:`);
    console.log(`  - Burned ${proofBalance} PROOF V3`);
    console.log(`  - Burned ${rfreeBalance} r-freestacc`);
    console.log(`  - Added liquidity to ${leadingPool.tokenSymbol}/SOL pool`);
    console.log(`  - LP tokens transferred to ${tx.sender}`);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[V2-PROCESS] Error processing transaction:', errorMsg);
    await markForRetry(tx.signature, errorMsg);
    console.log(`[V2-PROCESS] Transaction ${tx.signature} marked for retry`);
  }
}

// ============================================================================
// Monitoring Loop
// ============================================================================

let isMonitoringV2 = false;
let monitorIntervalV2: ReturnType<typeof setInterval> | null = null;

export async function startAutoTraderV2(): Promise<void> {
  if (isMonitoringV2) {
    console.log('[V2] Already running');
    return;
  }

  console.log('[V2] Starting Auto-Trader V2...');
  
  await getOrCreateSystemWallet();
  
  isMonitoringV2 = true;

  monitorIntervalV2 = setInterval(async () => {
    try {
      const transactions = await checkForIncomingTransactionsV2();
      
      for (const tx of transactions) {
        await processIncomingTransactionV2(tx);
      }
    } catch (error) {
      console.error('[V2] Monitor loop error:', error);
    }
  }, 10_000);

  console.log('[V2] Auto-Trader V2 started - monitoring for >= 0.1 SOL transfers');
}

export function stopAutoTraderV2(): void {
  isMonitoringV2 = false;
  if (monitorIntervalV2) {
    clearInterval(monitorIntervalV2);
    monitorIntervalV2 = null;
  }
  console.log('[V2] Auto-Trader V2 stopped');
}

export function getAutoTraderV2Status(): {
  isRunning: boolean;
  walletAddress: string | null;
  minSolRequired: number;
} {
  return {
    isRunning: isMonitoringV2,
    walletAddress: systemWallet?.publicKey.toBase58() || null,
    minSolRequired: MIN_SOL_LAMPORTS_V2 / 1e9,
  };
}
