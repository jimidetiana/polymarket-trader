/**
 * 一次性时区回填：把历史行从「MySQL 服务器本地时钟（UTC+8）」改成 UTC。
 *
 * 背景
 * ----
 * price-bot 的写入路径此前有两套时间基准混用：
 *  - recordLogsBatch 显式传 JS Date，经 mysql2 的 timezone:'Z' 存成 UTC（正确）
 *  - 其余 INSERT 省略时间列，落到列上的 DEFAULT CURRENT_TIMESTAMP，
 *    取的是 MySQL 服务器本地时钟（本机 UTC+8）
 * 读取端 toIsoUtc 无条件给裸时间串补 Z，于是 UTC+8 的值被当成 UTC 解析，
 * 前端再按 Asia/Shanghai 渲染又加 8 小时——所以「日志正确、触发记录和创建时间差 8 小时」。
 *
 * 写入侧已在 src/bots/price-bot/db.ts 统一为 UTC_TIMESTAMP()，本脚本只修历史行。
 *
 * 用法
 * ----
 * 必须在主 checkout 根目录执行——数据库口令从仓库根的 `数据库连接.txt` 读，
 * 该文件不在 git 里，worktree 内没有这份文件。
 *
 *   npx tsx scripts/fix-timezone-backfill.ts            # 只读预演，打印行数与样例
 *   npx tsx scripts/fix-timezone-backfill.ts --apply    # 真正执行
 *   npx tsx scripts/fix-timezone-backfill.ts --revert --apply   # 回滚
 *
 * 建议顺序：先停机器人 → --apply → 再启动。机器人在跑时执行也不会算错
 * （有 max_id 封顶），但停机执行最省心。
 *
 * !! 回填要么在「机器人以修复后的代码重启之前」执行，要么先钉边界 !!
 * 封顶用的 max_id 默认是脚本执行那一刻算出来的，不是重启那一刻。若先重启再跑，
 * 重启后写入的新行已经是 UTC，却仍落在 max_id 之内，会被再减 8 小时而变错。
 * 打算先重启的话，重启前先执行 --mark-cutoff 把边界固定在旧代码的最后一行。
 *
 * 安全设计
 * --------
 *  1) 每张表按 max_id 封顶，防止脚本自己执行期间新写入的行被卷进去。
 *     想把边界提前固定下来（比如打算先重启再回填），先执行：
 *       npx tsx scripts/fix-timezone-backfill.ts --mark-cutoff
 *     它只记录当前 max_id 不改数据；之后 --apply 会优先用这个记录的边界。
 *  2) price_bot_logs 只改 action <> 'price_update'——price_update 走 recordLogsBatch，
 *     本来就是 UTC，改了反而错。
 *  3) 执行记录写进 price_bot_tz_backfill，重复执行自动跳过；--revert 按记录精确反向。
 *  4) 先校验服务器偏移确实是 480 分钟，不是就中止，避免在别的机器上误算。
 */
import { pool } from '../src/soccer/db.js'

const APPLY = process.argv.includes('--apply')
const REVERT = process.argv.includes('--revert')
const MARK_CUTOFF = process.argv.includes('--mark-cutoff')

/** [表名, 时间列, 额外 WHERE 条件] */
const TARGETS: Array<[string, string, string | null]> = [
  ['price_bot_rules', 'created_at', null],
  ['price_bot_rules', 'updated_at', null],
  ['price_bot_triggers', 'triggered_at', null],
  ['price_bot_logs', 'logged_at', `action <> 'price_update'`],
  ['price_bot_orders', 'created_at', null],
  ['price_bot_connection_events', 'created_at', null],
]

async function q<T = any>(sql: string, params: any[] = []): Promise<T> {
  const [rows] = await pool.query<any>(sql, params)
  return rows as T
}

async function ensureMarker(): Promise<void> {
  await q(`
    CREATE TABLE IF NOT EXISTS price_bot_tz_backfill (
      id INT AUTO_INCREMENT PRIMARY KEY,
      table_name VARCHAR(64) NOT NULL,
      column_name VARCHAR(64) NOT NULL,
      max_id BIGINT NOT NULL,
      rows_changed INT NULL,
      offset_hours INT NOT NULL,
      cutoff_at DATETIME NULL,
      applied_at DATETIME NULL,
      reverted_at DATETIME NULL,
      UNIQUE KEY uk_target (table_name, column_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // 表可能是早先版本建的（applied_at NOT NULL、没有 cutoff_at）。
  // 逐列补齐，已经存在就忽略——CREATE TABLE IF NOT EXISTS 不会改已有表结构。
  const cols = await q<any[]>(
    `SELECT column_name AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'price_bot_tz_backfill'`,
  )
  const have = new Set(cols.map((r) => String(r.c).toLowerCase()))
  if (!have.has('cutoff_at')) {
    await q(`ALTER TABLE price_bot_tz_backfill ADD COLUMN cutoff_at DATETIME NULL AFTER offset_hours`)
  }
  // 只记边界时还没有 applied_at / rows_changed，得允许为空
  await q(`ALTER TABLE price_bot_tz_backfill MODIFY COLUMN applied_at DATETIME NULL`)
  await q(`ALTER TABLE price_bot_tz_backfill MODIFY COLUMN rows_changed INT NULL`)
}

/**
 * 只记录当前 max_id 作为回填边界，不动数据。
 *
 * 用途：打算「先重启机器人、之后再回填」时，先把边界钉在重启之前。
 * 否则重启后写入的新行（已是 UTC）会落在事后计算的 max_id 之内，被误减 8 小时。
 */
async function markCutoff(): Promise<void> {
  for (const [table, col, extra] of TARGETS) {
    const [{ max_id: maxId }] = await q<any[]>(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM ${table}`,
    )
    await q(
      `INSERT INTO price_bot_tz_backfill
         (table_name, column_name, max_id, rows_changed, offset_hours, cutoff_at)
       VALUES (?, ?, ?, NULL, 8, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE max_id=VALUES(max_id), cutoff_at=VALUES(cutoff_at)`,
      [table, col, maxId],
    )
    console.log(`已固定边界 ${`${table}.${col}`.padEnd(42)} max_id=${maxId}${extra ? `  (${extra})` : ''}`)
  }
  console.log('\n边界已记录，数据未改动。之后执行 --apply 会沿用这些边界。')
}

async function main(): Promise<void> {
  const [clock] = await q<any[]>(
    `SELECT NOW() AS srv_now, UTC_TIMESTAMP() AS utc_now,
            TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS offset_min`,
  )
  console.log(
    `服务器时钟: ${clock.srv_now} | UTC: ${clock.utc_now} | 偏移(分): ${clock.offset_min}`,
  )
  if (Number(clock.offset_min) !== 480) {
    console.log('\n!! 偏移不是 480 分钟，脚本假设不成立，中止。')
    return
  }

  await ensureMarker()

  if (MARK_CUTOFF) {
    await markCutoff()
    return
  }

  const done = await q<any[]>(`SELECT * FROM price_bot_tz_backfill`)
  const doneKey = new Map(done.map((r) => [`${r.table_name}.${r.column_name}`, r]))

  if (REVERT) {
    // 只回滚真正执行过的（applied_at 非空）；只记了边界的没改数据，无需回滚
    for (const rec of done.filter((r) => r.applied_at && !r.reverted_at)) {
      const extra = TARGETS.find(
        (t) => t[0] === rec.table_name && t[1] === rec.column_name,
      )?.[2]
      const where = [`id <= ${rec.max_id}`, extra].filter(Boolean).join(' AND ')
      const sql =
        `UPDATE ${rec.table_name} SET ${rec.column_name} = ` +
        `DATE_ADD(${rec.column_name}, INTERVAL ${rec.offset_hours} HOUR) WHERE ${where}`
      if (!APPLY) {
        console.log('[dry-run revert]', sql)
        continue
      }
      const r = await q<any>(sql)
      await q(`UPDATE price_bot_tz_backfill SET reverted_at = UTC_TIMESTAMP() WHERE id = ?`, [
        rec.id,
      ])
      console.log(`回滚 ${rec.table_name}.${rec.column_name}: ${r.affectedRows} 行`)
    }
    return
  }

  console.log('')
  for (const [table, col, extra] of TARGETS) {
    const key = `${table}.${col}`
    const prev = doneKey.get(key)
    if (prev?.applied_at && !prev.reverted_at) {
      console.log(`${key.padEnd(42)} 已回填过（${prev.rows_changed} 行），跳过`)
      continue
    }

    // 边界优先用 --mark-cutoff 记下的值：那是重启前的 max_id。
    // 现算的话，会把重启后写入的 UTC 新行也圈进来，再减 8 小时就错了。
    const pinned = prev?.cutoff_at ? Number(prev.max_id) : null
    const [{ max_id: liveMaxId }] = await q<any[]>(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM ${table}`,
    )
    const maxId = pinned ?? Number(liveMaxId)
    const where = [`id <= ${maxId}`, extra].filter(Boolean).join(' AND ')

    const [{ n }] = await q<any[]>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
    )
    if (pinned != null) {
      console.log(`${key.padEnd(42)} 沿用已固定边界 max_id=${pinned}（当前库内 max=${liveMaxId}）`)
    }

    const sample = await q<any[]>(
      `SELECT id, ${col} AS before_val, DATE_SUB(${col}, INTERVAL 8 HOUR) AS after_val
       FROM ${table} WHERE ${where} AND ${col} IS NOT NULL
       ORDER BY id DESC LIMIT 2`,
    )

    console.log(`${key.padEnd(42)} ${String(n).padStart(6)} 行  max_id=${maxId}`)
    for (const s of sample) {
      console.log(`   id=${s.id}  ${s.before_val}  ->  ${s.after_val}`)
    }

    if (APPLY) {
      const r = await q<any>(
        `UPDATE ${table} SET ${col} = DATE_SUB(${col}, INTERVAL 8 HOUR)
         WHERE ${where} AND ${col} IS NOT NULL`,
      )
      await q(
        `INSERT INTO price_bot_tz_backfill
           (table_name, column_name, max_id, rows_changed, offset_hours, applied_at)
         VALUES (?, ?, ?, ?, 8, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE max_id=VALUES(max_id), rows_changed=VALUES(rows_changed),
                                 applied_at=VALUES(applied_at), reverted_at=NULL`,
        [table, col, maxId, r.affectedRows],
      )
      console.log(`   -> 已更新 ${r.affectedRows} 行`)
    }
  }

  if (!APPLY) {
    console.log('\n(只读预演。加 --apply 才会真正写入)')
    printOrderHint()
  }
}

/** 打印建议的执行顺序，避免踩「先重启后回填」的坑 */
function printOrderHint(): void {
  console.log(
    [
      '',
      '顺序提醒：',
      '  A) 机器人当前是停的  ->  直接 --apply，然后再合并/重启，最省心',
      '  B) 想先重启再回填    ->  重启前先 --mark-cutoff 钉住边界，之后 --apply',
    ].join('\n'),
  )
}

main()
  .catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
