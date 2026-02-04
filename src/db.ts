import { eq, sql, and, or, lt, asc, ne, isNull, lte, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { mysqlTable, varchar, text, timestamp, int, boolean, bigint, mysqlEnum } from "drizzle-orm/mysql-core";
import 'dotenv/config';

// ============ Schema Definitions (inline for Railway deployment) ============

export const processedIncoming = mysqlTable('processed_incoming', {
  id: int('id').autoincrement().primaryKey(),
  incomingSignature: varchar('incoming_signature', { length: 128 }).notNull().unique(),
  sender: varchar('sender', { length: 64 }).notNull(),
  amountLamports: bigint('amount_lamports', { mode: 'bigint' }).notNull(),
  status: mysqlEnum('status', ['pending', 'processing', 'completed', 'failed', 'retry']).default('pending'),
  currentStep: varchar('current_step', { length: 32 }),
  retryCount: int('retry_count').default(0),
  lastError: text('last_error'),
  
  // Token info
  trendingTokenMint: varchar('trending_token_mint', { length: 64 }),
  trendingTokenSymbol: varchar('trending_token_symbol', { length: 32 }),
  
  // Transaction signatures
  proofSwapSignature: varchar('proof_swap_signature', { length: 128 }),
  trendingSwapSignature: varchar('trending_swap_signature', { length: 128 }),
  lpSignature: varchar('lp_signature', { length: 128 }),
  lockSignature: varchar('lock_signature', { length: 128 }),
  nftTransferSignature: varchar('nft_transfer_signature', { length: 128 }),
  
  // Pool info
  poolAddress: varchar('pool_address', { length: 64 }),
  positionAddress: varchar('position_address', { length: 64 }),
  positionNftMint: varchar('position_nft_mint', { length: 64 }),
  isNewPool: boolean('is_new_pool'),
  
  // Timestamps
  createdAt: timestamp('created_at').defaultNow(),
  completedAt: timestamp('completed_at'),
  nextRetryAt: timestamp('next_retry_at'),
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
      status: newRetryCount >= 5 ? 'failed' : 'retry',
      retryCount: newRetryCount,
      lastError: error,
      nextRetryAt,
    })
    .where(eq(processedIncoming.incomingSignature, signature));
}

/**
 * Get transactions that need retry
 */
export async function getTransactionsForRetry(): Promise<SelectProcessedIncoming[]> {
  const db = await getDb();
  if (!db) return [];
  
  const now = new Date();
  return db.select().from(processedIncoming)
    .where(and(
      eq(processedIncoming.status, 'retry'),
      or(
        isNull(processedIncoming.nextRetryAt),
        lte(processedIncoming.nextRetryAt, now)
      )
    ))
    .orderBy(asc(processedIncoming.createdAt))
    .limit(10);
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
