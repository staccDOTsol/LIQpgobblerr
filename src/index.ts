import { startAutoTraderV2 } from './auto-trader-v2.js';
import { startRaydiumTracker } from './raydium-tracker.js';

console.log('Starting Auto-Trader V2 + Raydium Pool Tracker for Railway deployment...');
console.log('System wallet: BzJR5q8YRs2KSXcQU7w9u29okrziU5bQ2oCVECC6CukE');

async function main() {
  // Start gRPC pool tracker first (needs to detect pools before V2 can use them)
  console.log('[STARTUP] Starting Raydium Pool Tracker (gRPC)...');
  await startRaydiumTracker();
  
  // Wait a few seconds for initial pool detection
  console.log('[STARTUP] Waiting 10s for initial pool detection...');
  await new Promise(resolve => setTimeout(resolve, 10_000));
  
  // Start V2 auto-trader
  console.log('[STARTUP] Starting Auto-Trader V2...');
  await startAutoTraderV2();
  
  console.log('[STARTUP] All systems running.');
}

main().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
