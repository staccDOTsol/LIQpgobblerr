/**
 * Raydium AMM Pool Tracker via Shyft Yellowstone gRPC
 * Railway-compatible version
 * 
 * 1. Subscribes to Raydium Legacy AMM account updates via gRPC
 * 2. Decodes pool state accounts (data size = 752 bytes)
 * 3. Filters for WSOL pairs only
 * 4. Checks LP mint supply = 0 (new/empty pools)
 * 5. Tracks SOL volume per hour for each pool
 * 6. Stores in database for real-time monitoring
 */

import YellowstoneClient from '@triton-one/yellowstone-grpc';
const Client = (YellowstoneClient as any).default || YellowstoneClient;
import { Connection, PublicKey } from '@solana/web3.js';
import { insertTrackedPool, updateTrackedPoolVolume } from './db.js';
import 'dotenv/config';

// ============================================================================
// Constants
// ============================================================================

const RAYDIUM_AMM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '0d4b4fd6-c2fc-4f55-b615-a23bab1ffc85';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const connection = new Connection(HELIUS_RPC_URL, 'confirmed');

const SHYFT_GRPC_URL = process.env.SHYFT_GRPC_URL || 'https://grpc.ny.shyft.to';
const SHYFT_GRPC_TOKEN = process.env.SHYFT_GRPC_TOKEN || '';

const AMM_POOL_STATE_SIZE = 752;

// ============================================================================
// Buffer Helpers
// ============================================================================

function readBigUint64LE(buf: Buffer | Uint8Array, offset = 0): bigint {
  const b = Buffer.from(buf);
  return b.readBigUInt64LE(offset);
}

function readBigUint128LE(buf: Buffer | Uint8Array, offset = 0): bigint {
  const b = Buffer.from(buf);
  const lo = b.readBigUInt64LE(offset);
  const hi = b.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

function readPublicKey(buf: Buffer | Uint8Array): string {
  return new PublicKey(Buffer.from(buf)).toBase58();
}

// ============================================================================
// Pool State Decoder
// ============================================================================

export interface DecodedPoolState {
  poolAddress: string;
  status: bigint;
  baseDecimal: bigint;
  quoteDecimal: bigint;
  poolOpenTime: bigint;
  swapBaseInAmount: bigint;
  swapQuoteOutAmount: bigint;
  swapQuoteInAmount: bigint;
  swapBaseOutAmount: bigint;
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  lpReserve: bigint;
  openOrders: string;
  marketId: string;
}

function decodePoolState(data: Buffer | Uint8Array, poolAddress: string): DecodedPoolState | null {
  try {
    if (data.length < AMM_POOL_STATE_SIZE) return null;
    
    const buf = Buffer.from(data);
    let offset = 0;
    
    const status = readBigUint64LE(buf, offset); offset += 8;
    offset += 8; // nonce
    offset += 8; // maxOrder
    offset += 8; // depth
    const baseDecimal = readBigUint64LE(buf, offset); offset += 8;
    const quoteDecimal = readBigUint64LE(buf, offset); offset += 8;
    offset += 8; // state
    offset += 8; // resetFlag
    offset += 8; // minSize
    offset += 8; // volMaxCutRatio
    offset += 8; // amountWaveRatio
    offset += 8; // baseLotSize
    offset += 8; // quoteLotSize
    offset += 8; // minPriceMultiplier
    offset += 8; // maxPriceMultiplier
    offset += 8; // systemDecimalValue
    offset += 8; // minSeparateNumerator
    offset += 8; // minSeparateDenominator
    offset += 8; // tradeFeeNumerator
    offset += 8; // tradeFeeDenominator
    offset += 8; // pnlNumerator
    offset += 8; // pnlDenominator
    offset += 8; // swapFeeNumerator
    offset += 8; // swapFeeDenominator
    offset += 8; // baseNeedTakePnl
    offset += 8; // quoteNeedTakePnl
    offset += 8; // quoteTotalPnl
    offset += 8; // baseTotalPnl
    const poolOpenTime = readBigUint64LE(buf, offset); offset += 8;
    offset += 8; // punishPcAmount
    offset += 8; // punishCoinAmount
    offset += 8; // orderbookToInitTime
    
    // u128 fields
    const swapBaseInAmount = readBigUint128LE(buf, offset); offset += 16;
    const swapQuoteOutAmount = readBigUint128LE(buf, offset); offset += 16;
    offset += 8; // swapBase2QuoteFee
    const swapQuoteInAmount = readBigUint128LE(buf, offset); offset += 16;
    const swapBaseOutAmount = readBigUint128LE(buf, offset); offset += 16;
    offset += 8; // swapQuote2BaseFee
    
    // Public key fields (32 bytes each)
    const baseVault = readPublicKey(buf.subarray(offset, offset + 32)); offset += 32;
    const quoteVault = readPublicKey(buf.subarray(offset, offset + 32)); offset += 32;
    const baseMint = readPublicKey(buf.subarray(offset, offset + 32)); offset += 32;
    const quoteMint = readPublicKey(buf.subarray(offset, offset + 32)); offset += 32;
    const lpMint = readPublicKey(buf.subarray(offset, offset + 32)); offset += 32;
    const openOrders = readPublicKey(buf.subarray(offset, offset + 32)); offset += 32;
    const marketId = readPublicKey(buf.subarray(offset, offset + 32)); offset += 32;
    offset += 32; // marketProgramId
    offset += 32; // targetOrders
    offset += 32; // withdrawQueue
    offset += 32; // lpVault
    offset += 32; // owner
    
    const lpReserve = readBigUint64LE(buf, offset);
    
    return {
      poolAddress, status, baseDecimal, quoteDecimal, poolOpenTime,
      swapBaseInAmount, swapQuoteOutAmount, swapQuoteInAmount, swapBaseOutAmount,
      baseVault, quoteVault, baseMint, quoteMint, lpMint, lpReserve,
      openOrders, marketId,
    };
  } catch (error) {
    console.error('[RAYDIUM-TRACKER] Error decoding pool state:', error);
    return null;
  }
}

// ============================================================================
// LP Mint Supply Check
// ============================================================================

const lpSupplyCache = new Map<string, { supply: bigint; checkedAt: number }>();
const LP_SUPPLY_CACHE_TTL = 60_000;

async function getLpMintSupply(lpMint: string): Promise<bigint> {
  const cached = lpSupplyCache.get(lpMint);
  if (cached && Date.now() - cached.checkedAt < LP_SUPPLY_CACHE_TTL) {
    return cached.supply;
  }
  
  try {
    const result = await connection.getTokenSupply(new PublicKey(lpMint));
    const supply = BigInt(result.value.amount);
    lpSupplyCache.set(lpMint, { supply, checkedAt: Date.now() });
    return supply;
  } catch (error) {
    console.error(`[RAYDIUM-TRACKER] Error fetching LP supply for ${lpMint}:`, error);
    return -1n;
  }
}

// ============================================================================
// Volume Tracking
// ============================================================================

interface PoolVolumeSnapshot {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  solSide: 'base' | 'quote';
  tokenMint: string;
  tokenSymbol: string;
  prevSwapBaseIn: bigint;
  prevSwapQuoteIn: bigint;
  prevSwapBaseOut: bigint;
  prevSwapQuoteOut: bigint;
  currSwapBaseIn: bigint;
  currSwapQuoteIn: bigint;
  currSwapBaseOut: bigint;
  currSwapQuoteOut: bigint;
  firstSeenAt: number;
  lastUpdateAt: number;
  updateCount: number;
  deltaSolVolumeLamports: bigint;
  totalOnChainSolLamports: bigint;
}

const poolVolumes = new Map<string, PoolVolumeSnapshot>();
const tokenMetaCache = new Map<string, { symbol: string; name: string }>();

async function getTokenMeta(mint: string): Promise<{ symbol: string; name: string }> {
  const cached = tokenMetaCache.get(mint);
  if (cached) return cached;
  
  try {
    const response = await fetch(HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAsset',
        params: { id: mint },
      }),
    });
    const data = await response.json() as any;
    const meta = {
      symbol: data?.result?.content?.metadata?.symbol || mint.slice(0, 6),
      name: data?.result?.content?.metadata?.name || 'Unknown',
    };
    tokenMetaCache.set(mint, meta);
    return meta;
  } catch {
    const fallback = { symbol: mint.slice(0, 6), name: 'Unknown' };
    tokenMetaCache.set(mint, fallback);
    return fallback;
  }
}

// ============================================================================
// Process Pool State Update
// ============================================================================

async function processPoolUpdate(poolAddress: string, data: Buffer | Uint8Array): Promise<void> {
  if (data.length !== AMM_POOL_STATE_SIZE) return;
  
  const decoded = decodePoolState(data, poolAddress);
  if (!decoded) return;
  
  const isBaseWsol = decoded.baseMint === WSOL_MINT;
  const isQuoteWsol = decoded.quoteMint === WSOL_MINT;
  if (!isBaseWsol && !isQuoteWsol) return;
  
  const lpSupply = await getLpMintSupply(decoded.lpMint);
  if (lpSupply !== 0n) return;
  
  const solSide = isBaseWsol ? 'base' : 'quote';
  const tokenMint = isBaseWsol ? decoded.quoteMint : decoded.baseMint;
  
  const existing = poolVolumes.get(poolAddress);
  const now = Date.now();
  
  if (!existing) {
    const meta = await getTokenMeta(tokenMint);
    
    let initialOnChainSol = 0n;
    if (solSide === 'base') {
      initialOnChainSol = decoded.swapBaseInAmount + decoded.swapBaseOutAmount;
    } else {
      initialOnChainSol = decoded.swapQuoteInAmount + decoded.swapQuoteOutAmount;
    }
    
    poolVolumes.set(poolAddress, {
      poolAddress, baseMint: decoded.baseMint, quoteMint: decoded.quoteMint,
      lpMint: decoded.lpMint, solSide, tokenMint, tokenSymbol: meta.symbol,
      prevSwapBaseIn: decoded.swapBaseInAmount, prevSwapQuoteIn: decoded.swapQuoteInAmount,
      prevSwapBaseOut: decoded.swapBaseOutAmount, prevSwapQuoteOut: decoded.swapQuoteOutAmount,
      currSwapBaseIn: decoded.swapBaseInAmount, currSwapQuoteIn: decoded.swapQuoteInAmount,
      currSwapBaseOut: decoded.swapBaseOutAmount, currSwapQuoteOut: decoded.swapQuoteOutAmount,
      firstSeenAt: now, lastUpdateAt: now, updateCount: 1,
      deltaSolVolumeLamports: 0n, totalOnChainSolLamports: initialOnChainSol,
    });
    
    console.log(`[RAYDIUM-TRACKER] New pool detected: ${poolAddress} (${meta.symbol}/SOL)`);
    
    await insertTrackedPool({
      poolAddress, tokenMint, tokenSymbol: meta.symbol,
      solPerHour: '0', totalSolVolume: '0',
    });
  } else {
    existing.currSwapBaseIn = decoded.swapBaseInAmount;
    existing.currSwapQuoteIn = decoded.swapQuoteInAmount;
    existing.currSwapBaseOut = decoded.swapBaseOutAmount;
    existing.currSwapQuoteOut = decoded.swapQuoteOutAmount;
    existing.lastUpdateAt = now;
    existing.updateCount++;
    
    let solDelta = 0n;
    if (solSide === 'base') {
      solDelta = (decoded.swapBaseInAmount - existing.prevSwapBaseIn) + (decoded.swapBaseOutAmount - existing.prevSwapBaseOut);
    } else {
      solDelta = (decoded.swapQuoteInAmount - existing.prevSwapQuoteIn) + (decoded.swapQuoteOutAmount - existing.prevSwapQuoteOut);
    }
    existing.deltaSolVolumeLamports = solDelta;
    
    if (solSide === 'base') {
      existing.totalOnChainSolLamports = decoded.swapBaseInAmount + decoded.swapBaseOutAmount;
    } else {
      existing.totalOnChainSolLamports = decoded.swapQuoteInAmount + decoded.swapQuoteOutAmount;
    }
  }
}

// ============================================================================
// Compute SOL/Hour
// ============================================================================

export function computeSolPerHour(): Array<{
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  solPerHour: number;
  totalSolVolume: number;
  totalOnChainVolume: number;
  ageMinutes: number;
  lastUpdateAt: number;
  updateCount: number;
  isActive: boolean;
}> {
  const now = Date.now();
  const results: typeof computeSolPerHour extends () => infer R ? R : never = [];
  
  const PRUNE_THRESHOLD_MS = 10 * 60 * 1000;
  const toRemove: string[] = [];
  
  for (const [addr, pool] of poolVolumes) {
    const ageMs = now - pool.firstSeenAt;
    const ageHours = ageMs / (1000 * 60 * 60);
    const ageMinutes = ageMs / (1000 * 60);
    const deltaSolVolume = Number(pool.deltaSolVolumeLamports) / 1e9;
    const totalOnChainVolume = Number(pool.totalOnChainSolLamports) / 1e9;
    const timeSinceLastUpdate = now - pool.lastUpdateAt;
    
    const isActive = timeSinceLastUpdate < 2 * 60 * 1000;
    
    if (timeSinceLastUpdate > PRUNE_THRESHOLD_MS && pool.deltaSolVolumeLamports === 0n) {
      toRemove.push(addr);
      continue;
    }
    
    const solPerHour = ageHours > 0 ? deltaSolVolume / ageHours : 0;
    
    results.push({
      poolAddress: pool.poolAddress, tokenMint: pool.tokenMint,
      tokenSymbol: pool.tokenSymbol, solPerHour,
      totalSolVolume: deltaSolVolume, totalOnChainVolume,
      ageMinutes: Math.round(ageMinutes), lastUpdateAt: pool.lastUpdateAt,
      updateCount: pool.updateCount, isActive,
    });
  }
  
  for (const addr of toRemove) { poolVolumes.delete(addr); }
  
  results.sort((a, b) => {
    if (b.solPerHour !== a.solPerHour) return b.solPerHour - a.solPerHour;
    return b.totalOnChainVolume - a.totalOnChainVolume;
  });
  
  return results;
}

// ============================================================================
// Periodic DB Flush
// ============================================================================

let flushInterval: ReturnType<typeof setInterval> | null = null;

async function flushToDB(): Promise<void> {
  const now = Date.now();
  for (const [, pool] of poolVolumes) {
    const ageHours = (now - pool.firstSeenAt) / (1000 * 60 * 60);
    const totalSolVolume = Number(pool.deltaSolVolumeLamports) / 1e9;
    const solPerHour = ageHours > 0 ? totalSolVolume / ageHours : 0;
    try {
      await updateTrackedPoolVolume(pool.poolAddress, solPerHour.toFixed(6), totalSolVolume.toFixed(9));
    } catch {}
  }
}

// ============================================================================
// gRPC Subscriber
// ============================================================================

let grpcClient: any = null;
let grpcStream: any = null;
let isTrackerRunning = false;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

export async function startRaydiumTracker(): Promise<void> {
  if (isTrackerRunning) {
    console.log('[RAYDIUM-TRACKER] Already running');
    return;
  }
  
  if (!SHYFT_GRPC_TOKEN) {
    console.warn('[RAYDIUM-TRACKER] No SHYFT_GRPC_TOKEN set, skipping');
    return;
  }
  
  isTrackerRunning = true;
  console.log('[RAYDIUM-TRACKER] Starting Raydium AMM pool tracker...');
  console.log(`[RAYDIUM-TRACKER] gRPC endpoint: ${SHYFT_GRPC_URL}`);
  
  flushInterval = setInterval(() => flushToDB(), 30_000);
  
  await connectGrpc();
}

async function connectGrpc(): Promise<void> {
  try {
    console.log('[RAYDIUM-TRACKER] Connecting to Shyft gRPC...');
    
    grpcClient = new Client(SHYFT_GRPC_URL, SHYFT_GRPC_TOKEN, undefined);
    await grpcClient.connect();
    console.log('[RAYDIUM-TRACKER] gRPC client connected');
    
    grpcStream = await grpcClient.subscribe();
    
    grpcStream.on('data', async (data: any) => {
      try {
        if (data.account?.account) {
          const account = data.account.account;
          const accountData = account.data;
          const pubkey = data.account.account.pubkey;
          
          if (accountData && pubkey) {
            const poolAddress = new PublicKey(Buffer.from(pubkey)).toBase58();
            const accountBuffer = Buffer.from(accountData);
            
            if (accountBuffer.length === AMM_POOL_STATE_SIZE) {
              await processPoolUpdate(poolAddress, accountBuffer);
            }
          }
        }
      } catch (error) {
        console.error('[RAYDIUM-TRACKER] Error processing message:', error);
      }
    });
    
    grpcStream.on('error', (error: any) => {
      console.error('[RAYDIUM-TRACKER] gRPC stream error:', error.message);
      scheduleReconnect();
    });
    
    grpcStream.on('end', () => {
      console.log('[RAYDIUM-TRACKER] gRPC stream ended');
      scheduleReconnect();
    });
    
    const request = {
      slots: {},
      accounts: {
        raydiumAmm: {
          account: [],
          filters: [{ datasize: BigInt(AMM_POOL_STATE_SIZE) }],
          owner: [RAYDIUM_AMM_PROGRAM_ID],
        },
      },
      transactions: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: 1,
      entry: {},
      transactionsStatus: {},
    };
    
    await grpcStream.write(request);
    console.log('[RAYDIUM-TRACKER] Subscribed to Raydium AMM accounts (data size filter: 752 bytes)');
    
  } catch (error) {
    console.error('[RAYDIUM-TRACKER] Failed to connect:', error);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (!isTrackerRunning) return;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  
  console.log('[RAYDIUM-TRACKER] Reconnecting in 5 seconds...');
  reconnectTimeout = setTimeout(async () => {
    try {
      if (grpcStream) { try { grpcStream.cancel(); } catch {} }
      await connectGrpc();
    } catch (error) {
      console.error('[RAYDIUM-TRACKER] Reconnect failed:', error);
      scheduleReconnect();
    }
  }, 5000);
}

export function stopRaydiumTracker(): void {
  isTrackerRunning = false;
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  if (flushInterval) { clearInterval(flushInterval); flushInterval = null; }
  if (grpcStream) { try { grpcStream.cancel(); } catch {} grpcStream = null; }
  grpcClient = null;
  console.log('[RAYDIUM-TRACKER] Stopped');
}
