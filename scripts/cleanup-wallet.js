import mysql from 'mysql2/promise';

const conn = await mysql.createConnection({
  host: '192.168.50.49',
  port: 3306,
  user: 'root',
  password: 'zhsh3600SS',
  database: 'polymarket_soccer',
  multipleStatements: true,
});

// 清除假数据
await conn.execute('DELETE FROM soccer_wallet_transactions');
await conn.execute(
  `DELETE FROM soccer_wallets WHERE wallet_address = ?`,
  ['0x0000000000000000000000000000000000000000'],
);

console.log('假数据已清除');

const [rows] = await conn.query('SELECT * FROM soccer_wallets');
console.log('钱包数量:', rows.length);

await conn.end();
