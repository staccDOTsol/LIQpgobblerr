import { startAutoTrader } from './auto-trader';

console.log('🚀 Starting Liquidity Monster Auto-Trader...');
console.log('');

startAutoTrader().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
