import { pool } from './src/soccer/db'

async function main() {
  const [rows] = await pool.query<any[]>(
    `SELECT id, market_id, question, outcome, handicap, model_probability, recommendation, calc_time
     FROM value_bot_calc_logs
     WHERE event_id = '831809' AND market_type = 'spread'
     ORDER BY calc_time DESC LIMIT 20`,
  )
  for (const r of rows) {
    console.log(`${r.calc_time} | q=${r.question} out=${r.outcome} hcp=${r.handicap} P=${r.model_probability} rec=${r.recommendation}`)
  }
  await pool.end()
}

main().catch(console.error)
