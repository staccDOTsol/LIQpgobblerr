/**
 * Automated Trading & Liquidity System
 *
 * Monitors incoming SOL transactions, swaps into PROOF V3 + trending memecoin,
 * creates/adds to Meteora DAMM V2 pools, locks liquidity, and sends LP NFT to sender.
 *
 * Uses existing Liquidity Monster backend APIs for all operations.
 */
import { Keypair } from '@solana/web3.js';
interface TrendingToken {
    address: string;
    symbol: string;
    name: string;
    price: number;
    priceChange24h: number;
    volume24h: number;
}
declare function getTopTrendingMemecoin(): Promise<TrendingToken | null>;
declare function getOrCreateSystemWallet(): Promise<Keypair>;
export declare function startMonitoring(): Promise<void>;
export declare function stopMonitoring(): void;
export declare function getMonitoringStatus(): {
    isMonitoring: boolean;
    systemWallet: string | null;
    processedCount: number;
    cachedTrendingToken: TrendingToken | null;
};
export { getTopTrendingMemecoin, getOrCreateSystemWallet };
export declare function startAutoTrader(): Promise<void>;
//# sourceMappingURL=auto-trader.d.ts.map