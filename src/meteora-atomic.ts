/**
 * Atomic LP Transaction Builder
 * 
 * Bundles Create Position + Add Liquidity + Lock + NFT Transfer into a single transaction
 * so everything happens atomically or fails together.
 * 
 * IMPORTANT: The position NFT is minted to the positionNftAccount PDA (derived from the NFT mint).
 * The wallet that creates the position has authority over this PDA token account.
 * To transfer the NFT, we transfer FROM the positionNftAccount PDA to the recipient's ATA.
 */

import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { derivePositionAddress, derivePositionNftAccount } from '@meteora-ag/cp-amm-sdk';
import { getCpAmm, getAssociatedTokenAddressForMint, createAtaInstructionForMint } from './meteora-damm.js';

// Use the same connection as meteora-damm
const HELIUS_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=0d4b4fd6-c2fc-4f55-b615-a23bab1ffc85';
const connection = new Connection(HELIUS_RPC_URL, 'confirmed');

interface AtomicLPResult {
  success: boolean;
  transaction: string | null; // Base64 encoded versioned transaction
  positionAddress: string | null;
  positionNftMint: string | null;
  error: string | null;
}

/**
 * Build a single atomic transaction that:
 * 1. Creates position (mints NFT to owner's ATA)
 * 2. Adds liquidity
 * 3. Locks the position permanently
 * 4. Transfers the NFT from owner's ATA to recipient's ATA
 * 
 * The key insight is that after createPosition, the NFT is in the OWNER's ATA
 * (derived from positionNftMint + owner), NOT in the positionNftAccount PDA.
 * The positionNftAccount is a program-derived account used for position tracking.
 */
export async function buildAtomicLPTransaction(
  poolAddress: string,
  tokenAMint: string,
  tokenBMint: string,
  tokenAAmount: string,
  tokenBAmount: string,
  systemWallet: Keypair,
  recipientAddress: string,
  slippageBps: number = 5000
): Promise<AtomicLPResult> {
  try {
    console.log('=== Building Atomic LP Transaction ===');
    const cpAmm = getCpAmm();
    
    const user = systemWallet.publicKey;
    const pool = new PublicKey(poolAddress);
    const recipient = new PublicKey(recipientAddress);
    
    // Fetch pool state
    const poolState = await cpAmm.fetchPoolState(pool);
    if (!poolState) {
      return { success: false, transaction: null, positionAddress: null, positionNftMint: null, error: 'Pool not found' };
    }
    
    const tokenA = poolState.tokenAMint;
    const tokenB = poolState.tokenBMint;
    
    // Determine token order
    const inputTokenA = new PublicKey(tokenAMint);
    const isTokenOrderMatched = tokenA.equals(inputTokenA);
    const actualTokenAAmount = isTokenOrderMatched ? tokenAAmount : tokenBAmount;
    const actualTokenBAmount = isTokenOrderMatched ? tokenBAmount : tokenAAmount;
    
    // Get token programs
    const { ata: userTokenAAta, tokenProgram: tokenAProgram } = await getAssociatedTokenAddressForMint(tokenA, user);
    const { ata: userTokenBAta, tokenProgram: tokenBProgram } = await getAssociatedTokenAddressForMint(tokenB, user);
    
    // Build ATA creation instructions for token accounts (if needed)
    const createAtaInstructions: TransactionInstruction[] = [];
    
    // Check if user token ATAs exist
    const userTokenAAtaInfo = await connection.getAccountInfo(userTokenAAta);
    if (!userTokenAAtaInfo) {
      createAtaInstructions.push(createAtaInstructionForMint(user, userTokenAAta, user, tokenA, tokenAProgram));
    }
    
    const userTokenBAtaInfo = await connection.getAccountInfo(userTokenBAta);
    if (!userTokenBAtaInfo) {
      createAtaInstructions.push(createAtaInstructionForMint(user, userTokenBAta, user, tokenB, tokenBProgram));
    }
    
    // Generate new position NFT keypair
    const positionNftMint = Keypair.generate();
    const positionNftMintPubkey = positionNftMint.publicKey;
    const positionAddress = derivePositionAddress(positionNftMintPubkey);
    const positionNftAccount = derivePositionNftAccount(positionNftMintPubkey);
    
    console.log('Position NFT mint:', positionNftMintPubkey.toBase58());
    console.log('Position PDA:', positionAddress.toBase58());
    console.log('Position NFT Account (PDA):', positionNftAccount.toBase58());
    
    // The owner's ATA for the position NFT - this is where the NFT will be minted
    const ownerNftAta = await getAssociatedTokenAddress(
      positionNftMintPubkey,
      user,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    console.log('Owner NFT ATA:', ownerNftAta.toBase58());
    
    // 1. Create Position Transaction (get instructions)
    // This mints the NFT to the owner's ATA
    const createPositionTx = await cpAmm.createPosition({
      owner: user,
      payer: user,
      pool,
      positionNft: positionNftMintPubkey,
    });
    
    // 2. Calculate deposit quote
    const tokenAAmountBN = new BN(actualTokenAAmount);
    const tokenBAmountBN = new BN(actualTokenBAmount);
    
    let depositQuote = cpAmm.getDepositQuote({
      inAmount: tokenAAmountBN,
      isTokenA: true,
      minSqrtPrice: poolState.sqrtMinPrice,
      maxSqrtPrice: poolState.sqrtMaxPrice,
      sqrtPrice: poolState.sqrtPrice,
    });
    
    let useTokenAAsInput = true;
    if (depositQuote.outputAmount.gt(tokenBAmountBN)) {
      console.log('Switching to tokenB as input...');
      depositQuote = cpAmm.getDepositQuote({
        inAmount: tokenBAmountBN,
        isTokenA: false,
        minSqrtPrice: poolState.sqrtMinPrice,
        maxSqrtPrice: poolState.sqrtMaxPrice,
        sqrtPrice: poolState.sqrtPrice,
      });
      useTokenAAsInput = false;
      
      if (depositQuote.outputAmount.gt(tokenAAmountBN)) {
        throw new Error(`Insufficient token balances for deposit`);
      }
    }
    
    console.log('Deposit quote:', {
      liquidityDelta: depositQuote.liquidityDelta.toString(),
      consumedInput: depositQuote.consumedInputAmount.toString(),
      outputAmount: depositQuote.outputAmount.toString(),
      useTokenAAsInput,
    });
    
    // Calculate max amounts with slippage
    const slippageMultiplier = 10000 + slippageBps;
    let maxTokenA: BN, maxTokenB: BN, thresholdA: BN, thresholdB: BN;
    
    if (useTokenAAsInput) {
      maxTokenA = depositQuote.consumedInputAmount.mul(new BN(slippageMultiplier)).div(new BN(10000));
      maxTokenB = depositQuote.outputAmount.mul(new BN(slippageMultiplier)).div(new BN(10000));
      thresholdA = depositQuote.consumedInputAmount;
      thresholdB = depositQuote.outputAmount;
    } else {
      maxTokenB = depositQuote.consumedInputAmount.mul(new BN(slippageMultiplier)).div(new BN(10000));
      maxTokenA = depositQuote.outputAmount.mul(new BN(slippageMultiplier)).div(new BN(10000));
      thresholdB = depositQuote.consumedInputAmount;
      thresholdA = depositQuote.outputAmount;
    }
    
    // 3. Add Liquidity Transaction (get instructions)
    const addLiquidityTx = await cpAmm.addLiquidity({
      owner: user,
      pool,
      position: positionAddress,
      positionNftAccount,
      liquidityDelta: depositQuote.liquidityDelta,
      maxAmountTokenA: maxTokenA,
      maxAmountTokenB: maxTokenB,
      tokenAAmountThreshold: thresholdA,
      tokenBAmountThreshold: thresholdB,
      tokenAMint: tokenA,
      tokenBMint: tokenB,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: tokenAProgram,
      tokenBProgram: tokenBProgram,
    });
    
    // 4. Lock Position Transaction (get instructions)
    const lockTx = await cpAmm.permanentLockPosition({
      owner: user,
      pool,
      position: positionAddress,
      positionNftAccount,
      unlockedLiquidity: depositQuote.liquidityDelta,
    });
    
    // 5. Transfer NFT to recipient
    // The NFT is in the positionNftAccount PDA, need to transfer to recipient's ATA
    const recipientNftAta = await getAssociatedTokenAddress(
      positionNftMintPubkey,
      recipient,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    console.log('Recipient NFT ATA:', recipientNftAta.toBase58());
    
    // Create recipient's ATA instruction
    const createRecipientAtaIx = createAssociatedTokenAccountInstruction(
      user, // payer
      recipientNftAta,
      recipient,
      positionNftMintPubkey,
      TOKEN_2022_PROGRAM_ID
    );
    
    // Transfer NFT from positionNftAccount PDA to recipient's ATA
    // The owner (systemWallet) has authority over the positionNftAccount PDA
    const transferNftIx = createTransferInstruction(
      positionNftAccount, // source: PDA where NFT was minted
      recipientNftAta, // destination: recipient's ATA
      user, // owner/authority of the position
      1, // amount (NFT = 1)
      [],
      TOKEN_2022_PROGRAM_ID
    );
    
    // Combine all instructions into one transaction
    const allInstructions: TransactionInstruction[] = [
      // Compute budget for complex transaction
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
      // Token ATA creation (if needed)
      ...createAtaInstructions,
      // Create position (mints NFT to owner's ATA)
      ...createPositionTx.instructions,
      // Add liquidity
      ...addLiquidityTx.instructions,
      // Lock position permanently
      ...lockTx.instructions,
      // Create recipient ATA and transfer NFT
      createRecipientAtaIx,
      transferNftIx,
    ];
    
    console.log(`Total instructions: ${allInstructions.length}`);
    
    // Build versioned transaction
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: allInstructions,
    }).compileToV0Message();
    
    const versionedTx = new VersionedTransaction(message);
    
    // Sign with system wallet and position NFT keypair
    versionedTx.sign([systemWallet, positionNftMint]);
    
    // Serialize to base64
    const serialized = Buffer.from(versionedTx.serialize()).toString('base64');
    
    console.log('Atomic transaction built successfully');
    
    return {
      success: true,
      transaction: serialized,
      positionAddress: positionAddress.toBase58(),
      positionNftMint: positionNftMintPubkey.toBase58(),
      error: null,
    };
    
  } catch (error) {
    console.error('Error building atomic LP transaction:', error);
    return {
      success: false,
      transaction: null,
      positionAddress: null,
      positionNftMint: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Submit the atomic transaction to the network with retry logic
 */
export async function submitAtomicTransaction(
  serializedTx: string
): Promise<{ success: boolean; signature: string | null; error: string | null }> {
  try {
    const txBuffer = Buffer.from(serializedTx, 'base64');
    const tx = VersionedTransaction.deserialize(txBuffer);
    
    console.log('Submitting atomic transaction...');
    
    const signature = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 5,
    });
    
    console.log('Submitted atomic tx:', signature);
    
    // Wait for confirmation with longer timeout
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: tx.message.recentBlockhash,
        lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight,
      },
      'confirmed'
    );
    
    if (confirmation.value.err) {
      console.error('Transaction failed:', confirmation.value.err);
      return {
        success: false,
        signature,
        error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
      };
    }
    
    console.log('Atomic transaction confirmed:', signature);
    
    return {
      success: true,
      signature,
      error: null,
    };
    
  } catch (error) {
    console.error('Error submitting atomic transaction:', error);
    return {
      success: false,
      signature: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


/**
 * Build a single atomic transaction for creating a NEW pool that:
 * 1. Creates pool with initial liquidity (with lock option)
 * 2. Transfers the NFT to recipient
 * 
 * This is used when no pool exists for the token pair.
 */
export async function buildAtomicPoolCreationTransaction(
  tokenAMint: string,
  tokenBMint: string,
  tokenAAmount: string,
  tokenBAmount: string,
  systemWallet: Keypair,
  recipientAddress: string
): Promise<AtomicLPResult & { poolAddress: string | null }> {
  try {
    console.log('=== Building Atomic Pool Creation Transaction ===');
    const cpAmm = getCpAmm();
    
    const user = systemWallet.publicKey;
    const recipient = new PublicKey(recipientAddress);
    
    const tokenA = new PublicKey(tokenAMint);
    const tokenB = new PublicKey(tokenBMint);
    
    // Get token programs
    const { tokenProgram: tokenAProgram } = await getAssociatedTokenAddressForMint(tokenA, user);
    const { tokenProgram: tokenBProgram } = await getAssociatedTokenAddressForMint(tokenB, user);
    
    // Generate new position NFT keypair
    const positionNftMint = Keypair.generate();
    const positionNftMintPubkey = positionNftMint.publicKey;
    const positionNftAccount = derivePositionNftAccount(positionNftMintPubkey);
    
    console.log('Position NFT mint:', positionNftMintPubkey.toBase58());
    console.log('Position NFT Account (PDA):', positionNftAccount.toBase58());
    
    // Get default config for pool creation
    const configs = await cpAmm.getAllConfigs();
    if (!configs || configs.length === 0) {
      throw new Error('No pool configs available');
    }
    const config = configs[0].publicKey;
    console.log('Using config:', config.toBase58());
    
    // Calculate initial price (1:1 ratio based on amounts)
    const tokenAAmountBN = new BN(tokenAAmount);
    const tokenBAmountBN = new BN(tokenBAmount);
    
    // Price = tokenB / tokenA (how many tokenB per tokenA)
    // For simplicity, use a 1:1 price and let the SDK handle the math
    const { getSqrtPriceFromPrice, getLiquidityDeltaFromAmountA, MIN_SQRT_PRICE, MAX_SQRT_PRICE } = await import('@meteora-ag/cp-amm-sdk');
    const initSqrtPrice = getSqrtPriceFromPrice('1', 9, 9); // Assuming both tokens have 9 decimals
    
    // Calculate liquidity delta from token amounts using full price range
    const liquidityDelta = getLiquidityDeltaFromAmountA(tokenAAmountBN, MIN_SQRT_PRICE, MAX_SQRT_PRICE);
    
    // Create pool with lock enabled
    const createPoolTx = await cpAmm.createPool({
      creator: user,
      payer: user,
      config,
      positionNft: positionNftMintPubkey,
      tokenAMint: tokenA,
      tokenBMint: tokenB,
      initSqrtPrice,
      liquidityDelta,
      tokenAAmount: tokenAAmountBN,
      tokenBAmount: tokenBAmountBN,
      activationPoint: null,
      tokenAProgram,
      tokenBProgram,
      isLockLiquidity: true, // Lock liquidity on creation
    });
    
    // Derive pool address
    const { derivePoolAddress } = await import('@meteora-ag/cp-amm-sdk');
    const poolAddress = derivePoolAddress(config, tokenA, tokenB);
    const positionAddress = derivePositionAddress(positionNftMintPubkey);
    
    console.log('Pool address:', poolAddress.toBase58());
    console.log('Position address:', positionAddress.toBase58());
    
    // Transfer NFT to recipient
    const recipientNftAta = await getAssociatedTokenAddress(
      positionNftMintPubkey,
      recipient,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    console.log('Recipient NFT ATA:', recipientNftAta.toBase58());
    
    // Create recipient's ATA instruction
    const createRecipientAtaIx = createAssociatedTokenAccountInstruction(
      user, // payer
      recipientNftAta,
      recipient,
      positionNftMintPubkey,
      TOKEN_2022_PROGRAM_ID
    );
    
    // Transfer NFT from positionNftAccount PDA to recipient's ATA
    const transferNftIx = createTransferInstruction(
      positionNftAccount, // source: PDA where NFT was minted
      recipientNftAta, // destination: recipient's ATA
      user, // owner/authority of the position
      1, // amount (NFT = 1)
      [],
      TOKEN_2022_PROGRAM_ID
    );
    
    // Combine all instructions into one transaction
    const allInstructions: TransactionInstruction[] = [
      // Compute budget for complex transaction
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }), // Higher for pool creation
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
      // Create pool (includes position creation + initial liquidity + lock)
      ...createPoolTx.instructions,
      // Create recipient ATA and transfer NFT
      createRecipientAtaIx,
      transferNftIx,
    ];
    
    console.log(`Total instructions: ${allInstructions.length}`);
    
    // Build versioned transaction
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: allInstructions,
    }).compileToV0Message();
    
    const versionedTx = new VersionedTransaction(message);
    
    // Sign with system wallet and position NFT keypair
    versionedTx.sign([systemWallet, positionNftMint]);
    
    // Serialize to base64
    const serialized = Buffer.from(versionedTx.serialize()).toString('base64');
    
    console.log('Atomic pool creation transaction built successfully');
    
    return {
      success: true,
      transaction: serialized,
      poolAddress: poolAddress.toBase58(),
      positionAddress: positionAddress.toBase58(),
      positionNftMint: positionNftMintPubkey.toBase58(),
      error: null,
    };
    
  } catch (error) {
    console.error('Error building atomic pool creation transaction:', error);
    return {
      success: false,
      transaction: null,
      poolAddress: null,
      positionAddress: null,
      positionNftMint: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
