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
            name: "incomingSignature";
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
        senderAddress: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "senderAddress";
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
            name: "amountLamports";
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
        status: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "status";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlEnumColumn";
            data: "pending" | "processing" | "completed" | "failed";
            driverParam: string;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["pending", "processing", "completed", "failed"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        errorMessage: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "errorMessage";
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
        currentStep: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "currentStep";
            tableName: "processed_incoming";
            dataType: "string";
            columnType: "MySqlEnumColumn";
            data: "check_pool" | "swap_proof" | "swap_trending" | "create_pool" | "lock_lp" | "transfer_nft" | "done";
            driverParam: string;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["check_pool", "swap_proof", "swap_trending", "create_pool", "lock_lp", "transfer_nft", "done"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        retryCount: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "retryCount";
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
        trendingTokenMint: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "trendingTokenMint";
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
            name: "trendingTokenSymbol";
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
            name: "proofSwapSignature";
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
            name: "trendingSwapSignature";
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
            name: "nftTransferSignature";
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
            name: "poolAddress";
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
            name: "positionAddress";
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
            name: "positionNftMint";
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
            name: "isNewPool";
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
            name: "createdAt";
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
            name: "completedAt";
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
        lastRetryAt: import("drizzle-orm/mysql-core").MySqlColumn<{
            name: "lastRetryAt";
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
            name: "nextRetryAt";
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