# Liquidity Monster Auto-Trader

Automated LP creation and NFT distribution service for the Liquidity Monster protocol. This service monitors incoming SOL transactions and automatically:

1. Swaps to PROOF V3 + trending memecoin (via Jupiter)
2. Creates/adds to Meteora DAMM V2 pools
3. Locks liquidity permanently
4. Transfers LP NFT to the sender

All operations are atomic - they either all succeed or all fail together.

## Quick Start (Railway Deployment)

### Step 1: Get Your System Wallet Private Key

Your system wallet private key is stored in your Manus project. You need to copy it:

1. Go to your Manus project
2. Find the file `.system-wallet.json` in the project root
3. Copy the `secretKey` value (it's a Base58 encoded string)

### Step 2: Get Your Database URL

1. Go to your Manus project's Management UI
2. Click on **Database** in the sidebar
3. Click the settings icon (bottom-left)
4. Copy the full connection string (starts with `mysql://`)

### Step 3: Deploy to Railway

1. Click **+ New** in Railway
2. Select **Deploy from GitHub repo** (or upload this folder)
3. Once deployed, go to **Variables** tab
4. Add these environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `SYSTEM_WALLET_PRIVATE_KEY` | ✅ Yes | Your Base58 encoded private key from `.system-wallet.json` |
| `DATABASE_URL` | ✅ Yes | MySQL connection string from Manus Database settings |
| `HELIUS_API_KEY` | No | Helius RPC API key (has default) |
| `BIRDEYE_API_KEY` | No | Birdeye API key for trending tokens (has default) |
| `JUPITER_API_KEY` | No | Jupiter API key (has default) |

5. Click **Deploy**

### Step 4: Verify It's Running

1. Go to **Deployments** tab
2. Click on the latest deployment
3. Check the logs - you should see:
   ```
   ✅ Environment variables validated
   Starting auto-trader monitoring...
   ✅ Auto-trader is running!
      System Wallet: <your wallet address>
   ```

## How It Works

The auto-trader polls for incoming SOL transactions every 10 seconds. When it detects a transfer above 0.01 SOL:

1. **Swap Phase**: Splits the SOL 47.5%/47.5% and swaps to PROOF V3 and the top trending memecoin
2. **LP Phase**: Creates or adds to a Meteora DAMM V2 pool with the swapped tokens
3. **Lock Phase**: Permanently locks the liquidity position
4. **Transfer Phase**: Sends the LP NFT to the original sender

All these operations happen in a single atomic transaction, ensuring nothing is lost if any step fails.

## Monitoring

Railway provides built-in logging. You can view:
- Transaction processing in real-time
- Error messages and retry attempts
- Wallet balances and swap amounts

## Troubleshooting

### "SYSTEM_WALLET_PRIVATE_KEY environment variable is required"
Make sure you've added the `SYSTEM_WALLET_PRIVATE_KEY` variable in Railway's Variables tab.

### "Invalid SYSTEM_WALLET_PRIVATE_KEY"
The private key must be Base58 encoded. Copy it exactly from your `.system-wallet.json` file.

### "Database connection failed"
Check that your `DATABASE_URL` is correct and includes `?ssl={"rejectUnauthorized":true}` at the end.

### Transactions not processing
1. Check the logs for error messages
2. Verify your system wallet has enough SOL for gas fees
3. Ensure the sender is sending at least 0.01 SOL

## Cost

Railway charges based on usage. For this service:
- **Estimated cost**: ~$5-10/month
- The service uses minimal CPU and memory
- Most cost comes from keeping the service running 24/7

## Files

```
src/
  index.ts          - Entry point
  auto-trader.ts    - Main monitoring and processing logic
  meteora-atomic.ts - Atomic transaction builder
  meteora-damm.ts   - Meteora SDK integration
  solana.ts         - Jupiter API integration
  nonce.ts          - Transaction helpers
  db.ts             - Database functions
```

## Support

If you encounter issues, check the Railway logs first. Most problems are related to:
- Missing environment variables
- Insufficient SOL balance
- Network congestion (transactions will auto-retry)
