import mysql from 'mysql2/promise';

const conn = await mysql.createConnection({
  host: '192.168.50.49',
  port: 3306,
  user: 'root',
  password: 'zhsh3600SS',
  database: 'polymarket_soccer',
});

// 检查前后空格导致的重复
const [spaceDups] = await conn.query(`
  SELECT TRIM(name_en) as trimmed, GROUP_CONCAT(name_en SEPARATOR ' | ') as names, COUNT(*) as cnt
  FROM soccer_teams
  GROUP BY TRIM(name_en) HAVING cnt > 1
`);
console.log('前后空格重复:', spaceDups.length, '组');
for (const row of spaceDups) {
  console.log(`  [${row.cnt}] ${row.names}`);
}

// 检查去掉 "FC" 后缀后的重复
const [fcDups] = await conn.query(`
  SELECT REPLACE(name_en, ' FC', '') as base, GROUP_CONCAT(name_en SEPARATOR ' | ') as names, COUNT(*) as cnt
  FROM soccer_teams
  WHERE name_en LIKE '% FC' OR name_en NOT LIKE '%FC%'
  GROUP BY REPLACE(name_en, ' FC', '') HAVING cnt > 1
  ORDER BY cnt DESC
  LIMIT 20
`);
console.log('\nFC后缀重复:', fcDups.length, '组');
for (const row of fcDups) {
  console.log(`  [${row.cnt}] ${row.names}`);
}

// 检查同名但联赛不同的球队
const [multiLeague] = await conn.query(`
  SELECT name_en, GROUP_CONCAT(DISTINCT league SEPARATOR ', ') as leagues, COUNT(DISTINCT league) as cnt
  FROM soccer_teams
  WHERE league IS NOT NULL
  GROUP BY name_en HAVING cnt > 1
  ORDER BY cnt DESC
  LIMIT 20
`);
console.log('\n同球队多联赛:', multiLeague.length, '组');
for (const row of multiLeague) {
  console.log(`  ${row.name_en} -> [${row.leagues}]`);
}

await conn.end();
