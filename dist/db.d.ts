import 'dotenv/config';
export declare const processedIncoming: import("drizzle-orm/mysql-core").MySqlTableWithColumns<{
    name: "processed_incoming";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "id";
            tableName: "processed_incoming";
            dataType: "number";
            columnType: "MySqlInt";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: true;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        incomingSignature: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "incoming_signature";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        sender: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "sender";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        amountLamports: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "amount_lamports";
            tableName: "processed_incoming";
            dataType: "bigint";
            columnType: "MySqlBigInt64";
            data: bigint;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "status";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlEnumColumn";
            data: "pending" | "processing" | "completed" | "failed" | "retry";
            driverParam: string;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["pending", "processing", "completed", "failed", "retry"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        currentStep: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "current_step";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        retryCount: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "retry_count";
            tableName: "processed_incoming";
            dataType: "number";
            columnType: "MySqlInt";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastError: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "last_error";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        trendingTokenMint: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "trending_token_mint";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        trendingTokenSymbol: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "trending_token_symbol";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        proofSwapSignature: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "proof_swap_signature";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        trendingSwapSignature: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "trending_swap_signature";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lpSignature: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "lp_signature";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lockSignature: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "lock_signature";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        nftTransferSignature: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "nft_transfer_signature";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        poolAddress: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "pool_address";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        positionAddress: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "position_address";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        positionNftMint: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "position_nft_mint";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlVarChar";
            data: string;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        isNewPool: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "is_new_pool";
            tableName: "processed_incoming";
            dataType: "boolean";
            columnType: "MySqlBoolean";
            data: boolean;
            driverParam: number | boolean;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "created_at";
            tableName: "processed_incoming";
            dataType: "date";
            columnType: "MySqlTimestamp";
            data: Date;
            driverParam: string | number;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        completedAt: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "completed_at";
            tableName: "processed_incoming";
            dataType: "date";
            columnType: "MySqlTimestamp";
            data: Date;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        nextRetryAt: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "next_retry_at";
            tableName: "processed_incoming";
            dataType: "date";
            columnType: "MySqlTimestamp";
            data: Date;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "mysql";
}>;
export type InsertProcessedIncoming = typeof processedIncoming.$inferInsert;
export type SelectProcessedIncoming = typeof processedIncoming.$inferSelect;
export declare function getDb(): Promise<(import("drizzle-orm/mysql2").MySql2Database<Record<string, unknown>> & {
    $client: import("mysql2").Pool;
}) | null>;
/**
 * Check if an incoming transaction has already been processed
 */
export declare function isTransactionProcessed(signature: string): Promise<boolean>;
/**
 * Insert a new processed incoming transaction record
 */
export declare function insertProcessedIncoming(record: InsertProcessedIncoming): Promise<void>;
/**
 * Update a processed incoming transaction record
 */
export declare function updateProcessedIncoming(signature: string, updates: Partial<InsertProcessedIncoming>): Promise<void>;
/**
 * Get a processed incoming transaction by signature
 */
export declare function getProcessedIncoming(signature: string): Promise<SelectProcessedIncoming | undefined>;
/**
 * Alias for getProcessedIncoming
 */
export declare function getProcessedIncomingBySignature(signature: string): Promise<SelectProcessedIncoming | undefined>;
/**
 * Mark a transaction for retry
 */
export declare function markForRetry(signature: string, error: string): Promise<void>;
/**
 * Get transactions that need retry
 */
export declare function getTransactionsForRetry(limit?: number): Promise<SelectProcessedIncoming[]>;
/**
 * Get recent processed transactions
 */
export declare function getRecentProcessedIncoming(limit?: number): Promise<SelectProcessedIncoming[]>;
//# sourceMappingURL=db.d.ts.map