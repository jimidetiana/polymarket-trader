// Test Polymarket balance endpoints
import { config } from '../src/config.js';
import { ClobClient } from '../src/api/clob.js';
import { privateKeyToAccount } from 'viem/accounts';
import { getOrCreateClobCredentials } from '../src/auth.js';

async function main() {
  const signer = privateKeyToAccount(config.privateKey);
  console.log('Signer:', signer.address);
  console.log('Wallet:', config.walletAddress);
  console.log('Proxy:', config.proxyAddress);

  const creds = await getOrCreateClobCredentials(signer, config.clobUrl);
  console.log('API Key:', creds.apiKey?.slice(0, 10) + '...');
  console.log('Secret:', creds.secret?.slice(0, 10) + '...');
  console.log('Passphrase:', creds.passphrase?.slice(0, 10) + '...');
  const client = new ClobClient(config.clobUrl, creds, signer.address);

  // Try different asset types
  for (const assetType of ['COLLATERAL', 'USDC', 'CONDITIONAL']) {
    try {
      const result = await client.getBalanceAllowance(assetType);
      console.log(`\n✅ ${assetType} => Balance: ${result.balance}, Allowance: ${result.allowance}`);
    } catch (err: any) {
      console.log(`\n❌ ${assetType} => ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
    }
  }

  // Also try with no asset_type
  try {
    const resp = await (client as any).axios.get('/balance-allowance');
    console.log('\n✅ no-asset =>', JSON.stringify(resp.data));
  } catch (err: any) {
    console.log('\n❌ no-asset =>', err.response?.status, JSON.stringify(err.response?.data));
  }
}

main().catch(console.error);
