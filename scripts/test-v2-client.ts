// Test with official clob-client-v2
import 'dotenv/config';
import { ClobClient, Chain } from '@polymarkets/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

async function main() {
  const host = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY!;
  const chainId = Chain.POLYGON;

  const account = privateKeyToAccount(privateKey);
  console.log('Signer:', account.address);
  console.log('Wallet:', process.env.POLYMARKET_WALLET_ADDRESS);
  console.log('Proxy:', process.env.POLYMARKET_PROXY_ADDRESS);

  const walletClient = createWalletClient({ account, transport: http('https://polygon-bor-rpc.publicnode.com') });

  // Step 1: Get API credentials
  const tempClient = new ClobClient({ host, chain: chainId, signer: walletClient });
  const creds = await tempClient.createOrDeriveApiKey();
  console.log('API Key:', creds.key?.slice(0, 10) + '...');
  console.log('Secret:', creds.secret?.slice(0, 10) + '...');
  console.log('Passphrase:', creds.passphrase?.slice(0, 10) + '...');

  // Step 2: Create authenticated client
  const client = new ClobClient({ host, chain: chainId, signer: walletClient, creds });

  // Try getBalanceAllowance
  try {
    const bal = await (client as any).getBalanceAllowance({ assetType: 'COLLATERAL' });
    console.log('\n✅ Balance:', JSON.stringify(bal));
  } catch (err: any) {
    console.log('\n❌ getBalanceAllowance:', err.response?.status, JSON.stringify(err.response?.data || err.message).slice(0, 200));
  }

  // Try alternative method names
  for (const method of ['getBalanceAllowance', 'balanceAllowance', 'getBalance']) {
    try {
      const result = await (client as any)[method]?.({ assetType: 'COLLATERAL' });
      if (result) console.log(`✅ ${method}:`, JSON.stringify(result).slice(0, 200));
    } catch (err: any) {
      console.log(`❌ ${method}:`, err.response?.status || '', (err.message || '').slice(0, 80));
    }
  }
}

main().catch(console.error);
