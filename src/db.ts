import { eq, and, or, isNull, lte, desc, asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { mysqlTable, varchar, text, timestamp, int, boolean, mysqlEnum } from "drizzle-orm/mysql-core";
import 'dotenv/config';

// ============ Schema Definitions - MUST MATCH ACTUAL DATABASE ============
// Column names are camelCase in the actual database!

export const processedIncoming = mysqlTable('processed_incoming', {
  id: int('id').autoincrement().primaryKey(),
  incomingSignature: varchar('incomingSignature', { length: 128 }).notNull().unique(),
  senderAddress: varchar('senderAddress', { length: 64 }).notNull(),
  amountLamports: varchar('amountLamports', { length: 64 }).notNull(),
  status: mysqlEnum('status', ['pending', 'processing', 'completed', 'failed']).default('pending'),
  errorMessage: text('errorMessage'),
  currentStep: mysqlEnum('currentStep', ['check_pool', 'swap_proof', 'swap_trending', 'swap_rfreestacc', 'swap_leading', 'add_liquidity', 'burn_tokens', 'transfer_lp', 'create_pool', 'lock_lp', 'transfer_nft', 'done']).default('check_pool'),
  retryCount: int('retryCount').default(0),
  
  // Token info
  trendingTokenMint: varchar('trendingTokenMint', { length: 64 }),
  trendingTokenSymbol: varchar('trendingTokenSymbol', { length: 20 }),
  
  // Transaction signatures
  proofSwapSignature: varchar('proofSwapSignature', { length: 128 }),
  trendingSwapSignature: varchar('trendingSwapSignature', { length: 128 }),
  nftTransferSignature: varchar('nftTransferSignature', { length: 128 }),
  
  // Pool info
  poolAddress: varchar('poolAddress', { length: 64 }),
  positionAddress: varchar('positionAddress', { length: 64 }),
  positionNftMint: varchar('positionNftMint', { length: 64 }),
  isNewPool: boolean('isNewPool'),
  
  // Timestamps
  createdAt: timestamp('createdAt').defaultNow(),
  completedAt: timestamp('completedAt'),
  lastRetryAt: timestamp('lastRetryAt'),
  nextRetryAt: timestamp('nextRetryAt'),
});

export type InsertProcessedIncoming = typeof processedIncoming.$inferInsert;
export type SelectProcessedIncoming = typeof processedIncoming.$inferSelect;

// ============ Database Connection ============

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
      console.log('[Database] Connected successfully');
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ============ Processed Incoming Transaction Helpers ============

/**
 * Check if an incoming transaction has already been processed
 */
export async function isTransactionProcessed(signature: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await db.select().from(processedIncoming)
    .where(eq(processedIncoming.incomingSignature, signature))
    .limit(1);
  return result.length > 0;
}

/**
 * Insert a new processed incoming transaction record
 */
export async function insertProcessedIncoming(record: InsertProcessedIncoming): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot insert processed incoming: database not available");
    return;
  }
  await db.insert(processedIncoming).values(record);
}

/**
 * Update a processed incoming transaction record
 */
export async function updateProcessedIncoming(
  signature: string,
  updates: Partial<InsertProcessedIncoming>
): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot update processed incoming: database not available");
    return;
  }
  await db.update(processedIncoming)
    .set(updates)
    .where(eq(processedIncoming.incomingSignature, signature));
}

/**
 * Get a processed incoming transaction by signature
 */
export async function getProcessedIncoming(signature: string): Promise<SelectProcessedIncoming | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(processedIncoming)
    .where(eq(processedIncoming.incomingSignature, signature))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * Alias for getProcessedIncoming
 */
export async function getProcessedIncomingBySignature(signature: string): Promise<SelectProcessedIncoming | undefined> {
  return getProcessedIncoming(signature);
}

/**
 * Mark a transaction for retry
 */
export async function markForRetry(signature: string, error: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  const record = await getProcessedIncoming(signature);
  if (!record) return;
  
  const newRetryCount = (record.retryCount || 0) + 1;
  const nextRetryAt = new Date(Date.now() + Math.min(newRetryCount * 60000, 300000)); // Max 5 min delay
  
  await db.update(processedIncoming)
    .set({
      status: newRetryCount >= 5 ? 'failed' : 'processing', // Use 'processing' since 'retry' not in enum
      retryCount: newRetryCount,
      errorMessage: error,
      lastRetryAt: new Date(),
      nextRetryAt,
    })
    .where(eq(processedIncoming.incomingSignature, signature));
}

/**
 * Get transactions that need retry
 */
export async function getTransactionsForRetry(limit: number = 10): Promise<SelectProcessedIncoming[]> {
  const db = await getDb();
  if (!db) return [];
  
  const now = new Date();
  return db.select().from(processedIncoming)
    .where(and(
      eq(processedIncoming.status, 'processing'),
      or(
        isNull(processedIncoming.nextRetryAt),
        lte(processedIncoming.nextRetryAt, now)
      )
    ))
    .orderBy(asc(processedIncoming.createdAt))
    .limit(limit);
}

/**
 * Get recent processed transactions
 */
export async function getRecentProcessedIncoming(limit: number = 50): Promise<SelectProcessedIncoming[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(processedIncoming)
    .orderBy(desc(processedIncoming.createdAt))
    .limit(limit);
}

// ============ Tracked Raydium Pools ============

export const trackedRaydiumPools = mysqlTable('tracked_raydium_pools', {
  id: int('id').autoincrement().primaryKey(),
  poolAddress: varchar('poolAddress', { length: 64 }).notNull().unique(),
  tokenMint: varchar('tokenMint', { length: 64 }).notNull(),
  tokenSymbol: varchar('tokenSymbol', { length: 20 }),
  solPerHour: varchar('solPerHour', { length: 64 }),
  totalSolVolume: varchar('totalSolVolume', { length: 64 }),
  lastUpdated: timestamp('lastUpdated').defaultNow(),
  createdAt: timestamp('createdAt').defaultNow(),
});

export type InsertTrackedRaydiumPool = typeof trackedRaydiumPools.$inferInsert;

export async function insertTrackedPool(pool: InsertTrackedRaydiumPool): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(trackedRaydiumPools).values(pool).onDuplicateKeyUpdate({
    set: {
      solPerHour: pool.solPerHour,
      totalSolVolume: pool.totalSolVolume,
      lastUpdated: new Date(),
    },
  });
}

export async function updateTrackedPoolVolume(
  poolAddress: string,
  solPerHour: string,
  totalSolVolume: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(trackedRaydiumPools)
    .set({ solPerHour, totalSolVolume, lastUpdated: new Date() })
    .where(eq(trackedRaydiumPools.poolAddress, poolAddress));
}

export async function getTrackedPools(limit: number = 100) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(trackedRaydiumPools)
    .orderBy(desc(trackedRaydiumPools.solPerHour))
    .limit(limit);
}

export async function deleteTrackedPool(poolAddress: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(trackedRaydiumPools)
    .where(eq(trackedRaydiumPools.poolAddress, poolAddress));
}
