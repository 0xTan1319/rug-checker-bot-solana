import { Connection, PublicKey } from "@solana/web3.js";
import { rayFee, solanaConnection } from "./config";
import { storeData } from "./utils";
import fs from "fs";
import chalk from "chalk";
import path from "path";
import axios from "axios";
import { TOKEN_PROGRAM_ID } from '../../corenft-mint/lib/scripts';
import { getMint } from "@solana/spl-token";

// Path to store new token data
const dataPath = path.join(__dirname, "data", "new_solana_tokens.json");

// Structure for consistent token data
interface NewTokenData {
  lpSignature: string;
  creator: string;
  creatorRugHistory: boolean;
  timestamp: string;
  baseInfo: {
    baseAddress: string;
    baseDecimals: number;
    baseLpAmount: number;
  };
  // logs: string[];
  rugCheckResult?: any;
  devHasSoldTokens?: boolean;
  tokenDistribution?: {
    bundledHoldings: {
      totalBundledAmount: number;
      bundledPercentage: number;
    };
    top10Percente: number;
  };
}

// Token Holder Information
interface TokenHolder {
  address: string;
  amount: number;
  percentage: number;
}

interface TokenDistribution {
  totalSupply: number;
  holders: TokenHolder[];
}

interface BundledHoldings {
  totalBundledAmount: number;
  bundledPercentage: number;
  bundledWallets: TokenHolder[];
}

// Function to check rug risk using RugCheck API
async function checkRug(mint: string) {
  try {
    console.log(`Checking rug risk for token with mint: ${mint}`);
    const response = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`
    );
    return response.data;
  } catch (error: any) {
    console.error(`Error checking token on RugCheck: ${error?.message}`);
    return null;
  }
}

// Function to get the holding amount of a specific mint in the developer's wallet
async function getDevHoldingAmount(connection: Connection, devWallet: string, mint: string): Promise<number> {
  try {
    console.log(`Fetching holding amount for mint ${mint} in wallet ${devWallet}`);

    // Get all token accounts owned by the developer's wallet
    const tokenAccounts = await connection.getTokenAccountsByOwner(new PublicKey(devWallet), {
      programId: TOKEN_PROGRAM_ID
    });

    let walletBalance = 0;

    for (const { account, pubkey } of tokenAccounts.value) {
      const accountData = account.data;
      const tokenMintAddress = new PublicKey(accountData.slice(0, 32)).toString();

      // Check if the token account is for the given mint address
      if (tokenMintAddress === mint) {
        walletBalance = accountData.readUInt32LE(64); // Exact balance logic may vary per SPL
        console.log(`Developer holds ${walletBalance} units of mint ${mint}`);
        // return balance;
        break;
      }
    }
    const mintInfo = await getMint(connection, new PublicKey(mint));
    const totalSupply = parseInt(mintInfo.supply.toString()) / Math.pow(10, mintInfo.decimals)

    if (totalSupply == 0) return 0;

    const holdingPercentage = walletBalance / totalSupply * 100;
    console.log(`Developer holds ${holdingPercentage}% of total supply for mint ${mint}`);
    return holdingPercentage

  } catch (error: any) {
    console.error(
      `Error fetching developer's holding amount for ${mint}: ${error.message}`
    );
    return 0;
  }
}

// Function to check if a developer has sold tokens
async function hasDevSoldToken(
  connection: Connection,
  devWallet: string,
  mint: string
): Promise<boolean> {
  try {
    console.log(`Checking if developer has sold tokens for mint ${mint}`);

    const devPublicKey = new PublicKey(devWallet);

    const signatures = await connection.getSignaturesForAddress(devPublicKey, {
      limit: 50, // Define the number of transactions to check
    });

    for (const signatureInfo of signatures) {
      const parsedTransaction = await connection.getParsedTransaction(
        signatureInfo.signature,
        { commitment: "confirmed" }
      );

      if (
        parsedTransaction &&
        parsedTransaction.meta &&
        parsedTransaction.meta.err == null
      ) {
        const postTokenBalances = parsedTransaction.meta.postTokenBalances || [];
        const preTokenBalances = parsedTransaction.meta.preTokenBalances || [];

        const preBalance = preTokenBalances.find(
          (balance) =>
            balance.owner === devWallet && balance.mint === mint
        );

        const postBalance = postTokenBalances.find(
          (balance) =>
            balance.owner === devWallet && balance.mint === mint
        );

        // Safely access `uiTokenAmount.uiAmount` using null-safe checks
        const preAmount = preBalance?.uiTokenAmount?.uiAmount ?? 0;
        const postAmount = postBalance?.uiTokenAmount?.uiAmount ?? 0;

        if (preAmount > postAmount) {
          console.log(`Developer has sold tokens for mint ${mint}`);
          return true;
        }
      }
    }

    console.log(`No transactions indicate token sales for mint ${mint}`);
    return false;
  } catch (error: any) {
    console.error(
      `Error checking if developer sold tokens for mint ${mint}: ${error.message}`
    );
    return false;
  }
}


// Function to get token holders
async function getTokenHolders(
  connection: Connection,
  mintAddress: string
): Promise<TokenDistribution> {
  try {
    const mint = new PublicKey(mintAddress);
    const accounts = await connection.getParsedProgramAccounts(
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      {
        filters: [
          {
            dataSize: 165,
          },
          {
            memcmp: {
              offset: 0,
              bytes: mint.toBase58(),
            },
          },
        ],
      }
    );

    const holders: TokenHolder[] = [];
    let totalSupply = 0;

    for (const account of accounts) {
      const parsedAccountInfo: any = account.account.data;
      const amount = Number(parsedAccountInfo.parsed.info.tokenAmount.amount);
      const decimals = parsedAccountInfo.parsed.info.tokenAmount.decimals;
      const uiAmount = amount / Math.pow(10, decimals);

      if (uiAmount > 0) {
        holders.push({
          address: account.pubkey.toString(),
          amount: uiAmount,
          percentage: 0,
        });
        totalSupply += uiAmount;
      }
    }

    holders.forEach(holder => {
      holder.percentage = (holder.amount / totalSupply) * 100;
    });

    return {
      totalSupply,
      holders,
    };
  } catch (error) {
    console.error("Error fetching token holders:", error);
    throw error;
  }
}

// Function to get top 10 token holders
async function getTopHolders(
  connection: Connection,
  mintAddress: string
): Promise<number> {

  try {

    const { holders } = await getTokenHolders(connection, mintAddress);

    if (!holders || holders.length === 0) {

      console.error("Holders data is empty or undefined");
      return 0;

    }

    // Ensure all items in holders array are valid and have the percentage property
    const validHolders = holders.filter(holder => typeof holder.percentage === 'number');

    if (validHolders.length === 0) {

      console.error("No valid holders with a percentage property");
      return 0;

    }

    const sortedHolders = validHolders.sort((a, b) => b.percentage - a.percentage);

    const top10holders = sortedHolders.slice(0, 10);

    if (!top10holders || top10holders.length === 0) {

      console.warn("No top10 holders found");
      return 0;

    }

    let top10Percentage = 0;

    for (let i = 0; i < top10holders.length; i++) {

      top10Percentage += top10holders[i].percentage;

    }

    console.log("🚀 ~ top10Percentage:", top10Percentage);

    return top10Percentage;

  } catch (error) {

    console.error("Error fetching top holders:", error);

    throw error;

  }

}

// Function to get bundled holdings (related wallets)
async function analyzeBundledHoldings(
  connection: Connection,
  mintAddress: string,
  threshold: number = 1
): Promise<BundledHoldings> {
  try {
    const { totalSupply, holders } = await getTokenHolders(connection, mintAddress);
    const significantHolders = holders.filter(h => h.percentage >= threshold);
    const sortedHolders = significantHolders.sort((a, b) => b.amount - a.amount);
    const totalBundledAmount = sortedHolders.reduce((sum, holder) => sum + holder.amount, 0);
    const bundledPercentage = (totalBundledAmount / totalSupply) * 100;

    return {
      totalBundledAmount,
      bundledPercentage,
      bundledWallets: sortedHolders,
    };
  } catch (error) {
    console.error("Error analyzing bundled holdings:", error);
    throw error;
  }
}

// Final Function for Monitoring New Tokens
export async function monitorNewTokens(connection: Connection) {
  console.log(chalk.green(`Monitoring new Solana tokens...`));

  try {
    connection.onLogs(
      rayFee,
      async ({ logs, err, signature }) => {
        try {
          if (err) {
            console.error(`Connection error: ${err}`);
            return;
          }

          console.log(chalk.bgGreen(`Found new token signature: ${signature}`));

          let signer = '';
          let baseAddress = '';
          let baseDecimals = 0;
          let baseLpAmount = 0;

          const parsedTransaction = await connection.getParsedTransaction(
            signature,
            {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }
          );

          if (parsedTransaction && parsedTransaction.meta?.err == null) {
            console.log(`Successfully parsed transaction`);

            let signer = parsedTransaction.transaction.message.accountKeys[0].pubkey.toString();
            const postTokenBalances = parsedTransaction.meta?.postTokenBalances;

            const baseInfo = postTokenBalances?.find(
              (balance) =>
                balance.owner === '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1' &&
                balance.mint !== 'So11111111111111111111111111111111111111112'
            );
            let creatorRug = false;

            if (baseInfo) {
              baseAddress = baseInfo.mint;
              baseDecimals = baseInfo.uiTokenAmount.decimals;
              baseLpAmount = baseInfo.uiTokenAmount.uiAmount ?? 0;

              const rugHistory = await checkRug(baseAddress);
              console.log("🚀 ~ rugHistory:", rugHistory.score)
              if(rugHistory.score >= 10000) {
                creatorRug = true;
              }
              
              // Get developer holding amount of the mint
              const devHoldingAmount = await getDevHoldingAmount(
                connection,
                signer,
                baseAddress
              );
              console.log(`Developer holding amount for ${baseAddress}: ${devHoldingAmount}`);
            }
            console.log("🚀 ~ creatorRug:", creatorRug)

            // Analyze token distribution
            const bundledAnalysis = await analyzeBundledHoldings(connection, baseAddress);
            const topHolders = await getTopHolders(connection, baseAddress);
            const devSold = await hasDevSoldToken(connection, signer, baseAddress);

            // Create and store token data
            const newTokenData: NewTokenData = {
              lpSignature: signature,
              creator: signer,
              creatorRugHistory: creatorRug,
              timestamp: new Date().toISOString(),
              baseInfo: {
                baseAddress,
                baseDecimals: baseDecimals,
                baseLpAmount: baseLpAmount,
              },
              // logs,
              devHasSoldTokens: devSold,
              tokenDistribution: {
                bundledHoldings: {
                  totalBundledAmount: bundledAnalysis.totalBundledAmount,
                  bundledPercentage: bundledAnalysis.bundledPercentage,
                },
                top10Percente: topHolders,
              },
            };
            console.log("🚀 ~ newTokenData:", newTokenData)
            await storeData(dataPath, newTokenData);
          }
        } catch (error) {
          console.error("Error processing transaction:", error);
        }
      },
      "confirmed"
    );
  } catch (error) {
    console.error("Error monitoring new tokens:", error);
  }
}

// Start Monitoring
monitorNewTokens(solanaConnection);
