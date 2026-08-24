import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
const text = fs.readFileSync(path.resolve('数据库连接.txt'), 'utf-8');
const urlMatch = text.match(/spring\.datasource\.url\s*=\s*(.+)/);
const userMatch = text.match(/spring\.datasource\.username\s*=\s*(.+)/);
const passMatch = text.match(/spring\.datasource\.password\s*=\s*(.+)/);
const parsed = new URL(urlMatch[1].trim().replace(/^jdbc:/, ''));
const pool = mysql.createPool({
  host: parsed.hostname, port: Number(parsed.port||3306),
  user: userMatch?.[1].trim() ?? 'root',
  password: passMatch?.[1].trim() ?? '',
  database: 'polymarket_soccer', charset: 'utf8mb4'
});

// Find an event that has moneyline markets
const [events] = await pool.execute(`
  SELECT e.id, e.title_en, e.home_team_en, e.away_team_en
  FROM soccer_events e
  WHERE e.title_en NOT LIKE '% - %'
  AND EXISTS (SELECT 1 FROM soccer_markets m WHERE m.event_id = e.id AND m.market_type = 'moneyline')
  LIMIT 3
`);

for (const evt of events) {
  console.log(`\n=== Event: ${evt.title_en} ===`);
  console.log(`Home: ${evt.home_team_en}, Away: ${evt.away_team_en}`);
  const [markets] = await pool.execute(
    'SELECT id, question_en, market_type, outcomes, clob_token_ids FROM soccer_markets WHERE event_id = ? ORDER BY market_type, id',
    [evt.id]
  );
  for (const m of markets) {
    console.log(`  [${m.market_type}] ${m.question_en?.substring(0,80)}`);
    console.log(`    Outcomes: ${m.outcomes}`);
    console.log(`    Tokens: ${m.clob_token_ids}`);
  }
}
await pool.end();
