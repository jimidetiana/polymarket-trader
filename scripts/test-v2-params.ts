// Test with official clob-client-v2 - find correct params
import 'dotenv/config';
import { ClobClient, Chain } from '@polymarkets/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import axios from 'axios';
import crypto from 'node:crypto';

async function main() {
  const host = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY!;
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, transport: http('https://polygon-bor-rpc.publicnode.com') });
  const walletAddress = process.env.POLYMARKET_WALLET_ADDRESS!;
  const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;

  console.log('Signer:', account.address);
  console.log('Wallet:', walletAddress);
  console.log('Proxy:', proxyAddress);

  // Get API credentials
  const tempClient = new ClobClient({ host, chain: Chain.POLYGON, signer: walletClient });
  const creds = await tempClient.createOrDeriveApiKey();

  // Test with different signature_type values
  for (const sigType of [0, 1, 2]) {
    for (const polyAddr of [account.address, walletAddress, proxyAddress].filter(Boolean) as string[]) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const path = `/balance-allowance?asset_type=COLLATERAL&signature_type=${sigType}`;
      const message = `${timestamp}GET${path}`;
      const standardB64 = creds.secret.replace(/-/g, '+').replace(/_/g, '/');
      const key = Buffer.from(standardB64, 'base64');
      const hmac = crypto.createHmac('sha256', key).update(message).digest();
      const signature = hmac.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

      try {
        const resp = await axios.get(`${host}/balance-allowance`, {
          params: { asset_type: 'COLLATERAL', signature_type: sigType },
          headers: {
            'POLY_ADDRESS': polyAddr,
            'POLY_API_KEY': creds.key,
            'POLY_PASSPHRASE': creds.passphrase,
            'POLY_TIMESTAMP': timestamp,
            'POLY_SIGNATURE': signature,
          },
        });
        const data = resp.data;
        const bal = data.balance || '0';
        console.log(`✅ sigType=${sigType} addr=${polyAddr.slice(0,10)}... => balance=${bal}`);
        if (Number(bal) > 0) {
          console.log('   FULL RESPONSE:', JSON.stringify(data));
        }
      } catch (err: any) {
        const status = err.response?.status;
        const errorMsg = JSON.stringify(err.response?.data).slice(0, 80);
        console.log(`❌ sigType=${sigType} addr=${polyAddr.slice(0,10)}... => ${status} ${errorMsg}`);
      }
    }
  }
}

main().catch(console.error);
