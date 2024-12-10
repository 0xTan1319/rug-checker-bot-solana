import { rayFee, solanaConnection } from './config';
import { storeData } from './utils';
import fs from 'fs';
import chalk from 'chalk';
import path from 'path';
import axios from 'axios';
import { Connection } from '@solana/web3.js';

const dataPath = path.join(__dirname, 'data', 'new_solana_tokens.json');

// Function to check rug risk using RugCheck API
async function checkRug(mint: string) {
  try {
    console.log(`Checking rug risk for token with mint: ${mint}`);

    // Call RugCheck API with the mint address
    const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
    
    // Return the RugCheck report if it is valid
    return response.data;
  } catch (error) {
    // Enhanced error logging for better understanding of API failure
    if (error.response) {
      console.error(`Error checking token on RugCheck: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`Error checking token on RugCheck: ${error.message}`);
    }
    return null; // Return null if RugCheck fails
  }
}

// Function to monitor new tokens and check for rug risk
async function monitorNewTokens(connection: Connection) {
  console.log(chalk.green(`Monitoring new Solana tokens...`));

  try {
    connection.onLogs(
      rayFee,  // This is the PublicKey we're using to listen for logs
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
          let quoteAddress = '';
          let quoteDecimals = 0;
          let quoteLpAmount = 0;

          // You need to use a proper RPC provider for getParsedTransaction to work.
          const parsedTransaction = await connection.getParsedTransaction(
            signature,
            {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }
          );

          if (parsedTransaction && parsedTransaction?.meta.err == null) {
            console.log(`Successfully parsed transaction`);

            signer = parsedTransaction?.transaction.message.accountKeys[0].pubkey.toString();
            console.log(`Creator: ${signer}`);

            const postTokenBalances = parsedTransaction?.meta.postTokenBalances;

            const baseInfo = postTokenBalances?.find(
              (balance) =>
                balance.owner ===
                  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1' &&
                balance.mint !== 'So11111111111111111111111111111111111111112'
            );

            if (baseInfo) {
              baseAddress = baseInfo.mint;
              baseDecimals = baseInfo.uiTokenAmount.decimals;
              baseLpAmount = baseInfo.uiTokenAmount.uiAmount;
            }

            const quoteInfo = postTokenBalances.find(
              (balance) =>
                balance.owner ==
                  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1' &&
                balance.mint == 'So11111111111111111111111111111111111111112'
            );

            if (quoteInfo) {
              quoteAddress = quoteInfo.mint;
              quoteDecimals = quoteInfo.uiTokenAmount.decimals;
              quoteLpAmount = quoteInfo.uiTokenAmount.uiAmount;
            }
          }

          // Create a new token data object
          const newTokenData = {
            lpSignature: signature,
            creator: signer,
            timestamp: new Date().toISOString(),
            baseInfo: {
              baseAddress,
              baseDecimals,
              baseLpAmount,
            },
            quoteInfo: {
              quoteAddress: quoteAddress,
              quoteDecimals: quoteDecimals,
              quoteLpAmount: quoteLpAmount,
            },
            logs: logs,
            rugCheckResult: null,  // Initially set to null until we get the RugCheck result
          };

          // Store new tokens data in the data folder
          await storeData(dataPath, newTokenData);

          // Call RugCheck API with the baseAddress (mint address) for rug risk check
          const rugCheckResult = await checkRug(baseAddress);
          
          if (rugCheckResult) {
            console.log(chalk.green(`RugCheck result for ${baseAddress}:`, JSON.stringify(rugCheckResult, null, 2)));  // Stringify the result
            newTokenData.rugCheckResult = rugCheckResult;  // Update the new token data with RugCheck result
            await storeData(dataPath, newTokenData); // Store updated token data with RugCheck result
          } else {
            console.log(chalk.yellow(`No RugCheck result for ${baseAddress}`));
          }
          
        } catch (error) {
          const errorMessage = `Error occurred in new Solana token log callback function: ${JSON.stringify(error, null, 2)}`;
          console.log(chalk.red(errorMessage));

          // Save error logs to a separate file
          fs.appendFile('errorNewTokensLogs.txt', `${errorMessage}\n`, function (err) {
            if (err) console.log('Error writing error logs', err);
          });
        }
      },
      'confirmed'
    );
  } catch (error) {
    const errorMessage = `Error occurred in new Solana LP monitor: ${JSON.stringify(error, null, 2)}`;
    console.log(chalk.red(errorMessage));

    // Save error logs to a separate file
    fs.appendFile('errorNewTokensLogs.txt', `${errorMessage}\n`, function (err) {
      if (err) console.log('Error writing error logs', err);
    });
  }
}

// Start monitoring new tokens
monitorNewTokens(solanaConnection);
