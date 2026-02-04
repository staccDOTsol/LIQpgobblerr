import { startAutoTrader } from './auto-trader.js';

console.log('Starting Auto-Trader for Railway deployment...');
console.log('System wallet: BzJR5q8YRs2KSXcQU7w9u29okrziU5bQ2oCVECC6CukE');

startAutoTrader().catch((error) => {
  console.error('Failed to start auto-trader:', error);
  process.exit(1);
});
