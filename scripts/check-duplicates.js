import mysql from 'mysql2/promise';

const conn = await mysql.createConnection({
  host: '192.168.50.49',
  port: 3306,
  user: 'root',
  password: 'zhsh3600SS',
  database: 'polymarket_soccer',
});

// 检查精确重复
const [exactDups] = await conn.query(`
  SELECT name_en, COUNT(*) as cnt FROM soccer_teams
  GROUP BY name_en HAVING cnt > 1
`);
console.log('精确重复:', exactDups.length, '组');

// 检查大小写不同的重复
const [caseDups] = await conn.query(`
  SELECT LOWER(name_en) as lower_name, GROUP_CONCAT(name_en) as names, COUNT(*) as cnt
  FROM soccer_teams
  GROUP BY LOWER(name_en) HAVING cnt > 1
  ORDER BY cnt DESC
`);
console.log('大小写重复:', caseDups.length, '组');
for (const row of caseDups) {
  console.log(`  [${row.cnt}] ${row.names}`);
}

// 统计总数
const [stats] = await conn.query('SELECT COUNT(*) as total FROM soccer_teams');
console.log('球队总数:', stats[0].total);

await conn.end();
