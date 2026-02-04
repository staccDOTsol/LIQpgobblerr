/**
 * Nonce Account Manager
 * 
 * Handles creation and management of durable nonce accounts for reliable transaction execution.
 * Nonce accounts allow transactions to be valid indefinitely (no blockhash expiration).
 * 
 * Flow:
 * 1. User creates nonce accounts upfront (one per transaction in sequence)
 * 2. Transactions are built using nonce instead of recentBlockhash
 * 3. Server broadcasts with exponential backoff until confirmed
 * 4. After each tx confirms, advance the nonce for the next tx
 */

import {
  Connection,
  Keypair,
  NonceAccount,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import bs58 from 'bs58';

// Helius RPC
const HELIUS_API_KEY = '0d4b4fd6-c2fc-4f55-b615-a23bab1ffc85';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const connection = new Connection(HELIUS_RPC_URL, 'confirmed');

// Rent for nonce account (0.00144768 SOL)
const NONCE_RENT_LAMPORTS = 1447680;

/**
 * Build instructions to create a nonce account
 * Returns the instructions and the nonce keypair
 */
export function buildCreateNonceAccountInstructions(
  payer: PublicKey,
  nonceKeypair: Keypair,
  authority: PublicKey
): TransactionInstruction[] {
  // Create account instruction
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: nonceKeypair.publicKey,
    lamports: NONCE_RENT_LAMPORTS,
    space: NONCE_ACCOUNT_LENGTH,
    programId: SystemProgram.programId,
  });

  // Initialize nonce instruction
  const initNonceIx = SystemProgram.nonceInitialize({
    noncePubkey: nonceKeypair.publicKey,
    authorizedPubkey: authority,
  });

  return [createAccountIx, initNonceIx];
}

/**
 * Build a transaction to create multiple nonce accounts
 * User signs this once to create all nonces needed for the swap sequence
 */
export async function buildCreateNonceAccountsTransaction(
  payer: PublicKey,
  count: number,
  authority: PublicKey
): Promise<{
  transaction: string; // base64 encoded
  nonceKeypairs: string[]; // base58 encoded secret keys
  noncePublicKeys: string[]; // base58 encoded public keys
}> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  
  const nonceKeypairs: Keypair[] = [];
  const instructions: TransactionInstruction[] = [];
  
  for (let i = 0; i < count; i++) {
    const nonceKeypair = Keypair.generate();
    nonceKeypairs.push(nonceKeypair);
    
    const ixs = buildCreateNonceAccountInstructions(payer, nonceKeypair, authority);
    instructions.push(...ixs);
  }
  
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  
  const tx = new VersionedTransaction(message);
  
  // Pre-sign with all nonce keypairs (user will add their signature)
  for (const keypair of nonceKeypairs) {
    tx.sign([keypair]);
  }
  
  return {
    transaction: Buffer.from(tx.serialize()).toString('base64'),
    nonceKeypairs: nonceKeypairs.map(kp => bs58.encode(kp.secretKey)),
    noncePublicKeys: nonceKeypairs.map(kp => kp.publicKey.toBase58()),
  };
}

/**
 * Get the current nonce value from a nonce account
 */
export async function getNonceValue(nonceAccountPubkey: PublicKey): Promise<string | null> {
  try {
    const accountInfo = await connection.getAccountInfo(nonceAccountPubkey);
    if (!accountInfo) {
      console.error('Nonce account not found:', nonceAccountPubkey.toBase58());
      return null;
    }
    
    const nonceAccount = NonceAccount.fromAccountData(accountInfo.data);
    return nonceAccount.nonce;
  } catch (error) {
    console.error('Error getting nonce value:', error);
    return null;
  }
}

/**
 * Build an advance nonce instruction
 * This must be the FIRST instruction in any transaction using a nonce
 */
export function buildAdvanceNonceInstruction(
  noncePubkey: PublicKey,
  authorizedPubkey: PublicKey
): TransactionInstruction {
  return SystemProgram.nonceAdvance({
    noncePubkey,
    authorizedPubkey,
  });
}

/**
 * Prepend nonce advance instruction to an existing transaction
 * Replaces the blockhash with the nonce value
 */
export async function convertToNonceTransaction(
  transaction: VersionedTransaction,
  nonceAccountPubkey: PublicKey,
  nonceAuthority: PublicKey
): Promise<VersionedTransaction | null> {
  try {
    // Get the nonce value
    const nonceValue = await getNonceValue(nonceAccountPubkey);
    if (!nonceValue) {
      console.error('Could not get nonce value');
      return null;
    }
    
    // Get the original message
    const originalMessage = transaction.message;
    
    // Create advance nonce instruction
    const advanceNonceIx = buildAdvanceNonceInstruction(nonceAccountPubkey, nonceAuthority);
    
    // We need to rebuild the transaction with nonce as first instruction
    // This is complex with VersionedTransaction, so we'll use a different approach:
    // Build a new transaction with the nonce instruction prepended
    
    // For now, return null - we'll handle this differently
    // The transaction should be built with nonce from the start
    console.log('Converting transaction to use nonce:', nonceValue);
    
    return null; // TODO: Implement full conversion
  } catch (error) {
    console.error('Error converting to nonce transaction:', error);
    return null;
  }
}

/**
 * Build a transaction that uses a nonce account instead of blockhash
 * The nonce advance instruction is automatically prepended
 */
export async function buildNonceTransaction(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  nonceAccountPubkey: PublicKey,
  nonceAuthority: PublicKey
): Promise<VersionedTransaction | null> {
  try {
    // Get the nonce value
    const nonceValue = await getNonceValue(nonceAccountPubkey);
    if (!nonceValue) {
      console.error('Could not get nonce value');
      return null;
    }
    
    // Prepend the advance nonce instruction
    const advanceNonceIx = buildAdvanceNonceInstruction(nonceAccountPubkey, nonceAuthority);
    const allInstructions = [advanceNonceIx, ...instructions];
    
    // Build message with nonce as the "blockhash"
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: nonceValue, // Use nonce value instead of blockhash
      instructions: allInstructions,
    }).compileToV0Message();
    
    return new VersionedTransaction(message);
  } catch (error) {
    console.error('Error building nonce transaction:', error);
    return null;
  }
}

/**
 * Submit a transaction with exponential backoff until confirmed
 * Works with both regular and nonce transactions
 */
export async function submitWithExponentialBackoff(
  signedTransaction: Buffer,
  maxRetries: number = 20,
  initialDelayMs: number = 500,
  maxDelayMs: number = 30000
): Promise<{
  success: boolean;
  signature: string | null;
  error: string | null;
  attempts: number;
}> {
  let delay = initialDelayMs;
  let attempts = 0;
  let lastSignature: string | null = null;
  let lastError: string | null = null;
  
  while (attempts < maxRetries) {
    attempts++;
    
    try {
      // Send the transaction
      const signature = await connection.sendRawTransaction(signedTransaction, {
        skipPreflight: true,
        maxRetries: 0,
      });
      lastSignature = signature;
      console.log(`Attempt ${attempts}: Sent tx ${signature.slice(0, 20)}...`);
      
      // Wait a bit then check status
      await new Promise(r => setTimeout(r, 2000));
      
      // Check if confirmed
      const status = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      
      if (status.value) {
        if (status.value.err) {
          // Transaction failed on-chain
          lastError = JSON.stringify(status.value.err);
          console.error(`Attempt ${attempts}: TX failed on-chain:`, lastError);
          
          // If it's a permanent error, don't retry
          const errStr = lastError.toLowerCase();
          if (errStr.includes('insufficient') || errStr.includes('already processed')) {
            return {
              success: false,
              signature,
              error: lastError,
              attempts,
            };
          }
        } else if (
          status.value.confirmationStatus === 'confirmed' ||
          status.value.confirmationStatus === 'finalized'
        ) {
          console.log(`Attempt ${attempts}: TX CONFIRMED!`);
          return {
            success: true,
            signature,
            error: null,
            attempts,
          };
        }
      }
      
      // Check for blockhash expiration (only for non-nonce transactions)
      // Nonce transactions don't expire
      
    } catch (err: any) {
      const msg = err?.message || String(err);
      lastError = msg;
      
      // Blockhash expired - for regular transactions, this is fatal
      if (msg.includes('Blockhash not found') || msg.includes('block height exceeded')) {
        console.error(`Attempt ${attempts}: Blockhash expired`);
        return {
          success: false,
          signature: lastSignature,
          error: 'Blockhash expired - transaction cannot land',
          attempts,
        };
      }
      
      // Already processed - check if it succeeded
      if (msg.includes('AlreadyProcessed') || msg.includes('already been processed')) {
        console.log(`Attempt ${attempts}: Already processed, checking status...`);
        if (lastSignature) {
          const status = await connection.getSignatureStatus(lastSignature, {
            searchTransactionHistory: true,
          });
          if (status.value && !status.value.err) {
            return {
              success: true,
              signature: lastSignature,
              error: null,
              attempts,
            };
          }
        }
      }
      
      console.warn(`Attempt ${attempts}: Error: ${msg.slice(0, 100)}`);
    }
    
    // Exponential backoff
    console.log(`Waiting ${delay}ms before retry...`);
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, maxDelayMs);
  }
  
  return {
    success: false,
    signature: lastSignature,
    error: lastError || 'Max retries exceeded',
    attempts,
  };
}

/**
 * Submit multiple transactions sequentially with exponential backoff
 * Each transaction must confirm before the next is submitted
 */
export async function submitSequentialTransactions(
  signedTransactions: string[], // base64 encoded
  onProgress?: (index: number, total: number, status: 'pending' | 'confirmed' | 'failed', signature?: string) => void
): Promise<{
  success: boolean;
  signatures: string[];
  failedIndex: number | null;
  error: string | null;
}> {
  const signatures: string[] = [];
  
  for (let i = 0; i < signedTransactions.length; i++) {
    const txBase64 = signedTransactions[i];
    const txBuffer = Buffer.from(txBase64, 'base64');
    
    console.log(`\n=== Submitting TX ${i + 1}/${signedTransactions.length} ===`);
    onProgress?.(i, signedTransactions.length, 'pending');
    
    const result = await submitWithExponentialBackoff(txBuffer);
    
    if (result.success && result.signature) {
      signatures.push(result.signature);
      console.log(`TX ${i + 1} confirmed: ${result.signature}`);
      onProgress?.(i, signedTransactions.length, 'confirmed', result.signature);
    } else {
      console.error(`TX ${i + 1} failed after ${result.attempts} attempts: ${result.error}`);
      onProgress?.(i, signedTransactions.length, 'failed', result.signature || undefined);
      
      return {
        success: false,
        signatures,
        failedIndex: i,
        error: `Transaction ${i + 1} failed: ${result.error}`,
      };
    }
  }
  
  return {
    success: true,
    signatures,
    failedIndex: null,
    error: null,
  };
}

export { connection, NONCE_RENT_LAMPORTS };
