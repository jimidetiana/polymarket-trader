// Quick test: query CLOB API allowances endpoint
import { config } from '../src/config.js';
import { ClobClient } from '../src/api/clob.js';
import { privateKeyToAccount } from 'viem/accounts';
import { getOrCreateClobCredentials } from '../src/auth.js';

async function main() {
  const signer = privateKeyToAccount(config.privateKey);
  console.log('Signer address:', signer.address);
  console.log('Wallet address:', config.walletAddress);
  console.log('Proxy address:', config.proxyAddress);

  const creds = await getOrCreateClobCredentials(signer, config.clobUrl);
  const client = new ClobClient(config.clobUrl, creds, signer.address);

  // Try different API endpoints
  try {
    console.log('\n--- GET /allowances ---');
    const resp1 = await (client as any).axios.get('/allowances');
    console.log(JSON.stringify(resp1.data, null, 2));
  } catch (err: any) {
    console.log('Error:', err.response?.status, err.response?.statusText);
    console.log('Data:', JSON.stringify(err.response?.data));
  }

  try {
    console.log('\n--- GET /balance ---');
    const resp2 = await (client as any).axios.get('/balance');
    console.log(JSON.stringify(resp2.data, null, 2));
  } catch (err: any) {
    console.log('Error:', err.response?.status, err.response?.statusText);
    console.log('Data:', JSON.stringify(err.response?.data));
  }

  try {
    console.log('\n--- GET /profile ---');
    const resp3 = await (client as any).axios.get('/profile');
    console.log(JSON.stringify(resp3.data, null, 2));
  } catch (err: any) {
    console.log('Error:', err.response?.status, err.response?.statusText);
  }

  try {
    console.log('\n--- GET /data/wallet ---');
    const resp4 = await (client as any).axios.get('/data/wallet');
    console.log(JSON.stringify(resp4.data, null, 2));
  } catch (err: any) {
    console.log('Error:', err.response?.status, err.response?.statusText);
  }
}

main().catch(console.error);
