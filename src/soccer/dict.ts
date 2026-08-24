import mysql from 'mysql2/promise';
import { pool } from './db.js';
import { translateTeamName, translateText, TEAM_NAME_MAP } from './fetcher.js';

export interface TeamDictRow {
  id: number;
  name_en: string;
  name_zh: string | null;
  league: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeagueDictRow {
  id: number;
  name_en: string;
  name_zh: string | null;
  created_at: string;
  updated_at: string;
}

// ---- Team dictionary ----

export async function getAllTeams(): Promise<TeamDictRow[]> {
  const [rows] = await pool.execute<TeamDictRow[] & mysql.RowDataPacket[]>(
    `SELECT * FROM soccer_teams ORDER BY name_en ASC`,
  );
  return rows;
}

export async function getTeamsByLeague(league: string): Promise<TeamDictRow[]> {
  const [rows] = await pool.execute<TeamDictRow[] & mysql.RowDataPacket[]>(
    `SELECT * FROM soccer_teams WHERE league = ? ORDER BY name_en ASC`,
    [league],
  );
  return rows;
}

export async function getUntranslatedTeams(limit = 200): Promise<TeamDictRow[]> {
  const [rows] = await pool.execute<TeamDictRow[] & mysql.RowDataPacket[]>(
    `SELECT * FROM soccer_teams WHERE name_zh IS NULL OR name_zh = '' ORDER BY name_en ASC LIMIT ?`,
    [limit],
  );
  return rows;
}

// Normalize team name for dedup matching: lowercase + strip "FC" suffix + collapse spaces
export function normalizeTeamName(en: string): string {
  return en.trim().replace(/\s+FC$/i, '').replace(/\s+/g, ' ').toLowerCase();
}

// Find existing team by normalized name (case-insensitive, with/without FC suffix)
async function findExistingTeamName(nameEn: string): Promise<string | null> {
  const normalized = normalizeTeamName(nameEn);
  if (!normalized) return null;
  const [rows] = await pool.execute<{ name_en: string }[] & mysql.RowDataPacket[]>(
    `SELECT name_en FROM soccer_teams WHERE LOWER(REPLACE(REPLACE(name_en, ' FC', ''), '  ', ' ')) = ? LIMIT 1`,
    [normalized],
  );
  return rows.length > 0 ? rows[0].name_en : null;
}

export async function upsertTeam(nameEn: string, nameZh: string | null, league?: string | null): Promise<void> {
  const trimmed = nameEn.trim();
  // Check for existing team with normalized name to avoid duplicates
  const existingName = await findExistingTeamName(trimmed);
  const canonicalName = existingName || trimmed;

  await pool.execute(
    `INSERT INTO soccer_teams (name_en, name_zh, league)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name_zh = COALESCE(VALUES(name_zh), name_zh),
       league = COALESCE(VALUES(league), league)`,
    [canonicalName, nameZh?.trim() || null, league?.trim() || null],
  );
}

export async function updateTeam(id: number, data: { name_zh?: string; league?: string }): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (data.name_zh !== undefined) {
    fields.push('name_zh = ?');
    values.push(data.name_zh.trim() || null);
  }
  if (data.league !== undefined) {
    fields.push('league = ?');
    values.push(data.league.trim() || null);
  }
  if (!fields.length) return;
  values.push(id);
  await pool.execute(`UPDATE soccer_teams SET ${fields.join(', ')} WHERE id = ?`, values);
}

export async function deleteTeam(id: number): Promise<void> {
  await pool.execute(`DELETE FROM soccer_teams WHERE id = ?`, [id]);
}

export async function getTeamTranslationMap(): Promise<Record<string, string>> {
  const [rows] = await pool.execute<{ name_en: string; name_zh: string }[] & mysql.RowDataPacket[]>(
    `SELECT name_en, name_zh FROM soccer_teams WHERE name_zh IS NOT NULL AND name_zh <> ''`,
  );
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.name_en] = row.name_zh;
  }
  return map;
}

// ---- League dictionary ----

export async function getAllLeagues(): Promise<LeagueDictRow[]> {
  const [rows] = await pool.execute<LeagueDictRow[] & mysql.RowDataPacket[]>(
    `SELECT * FROM soccer_leagues ORDER BY name_en ASC`,
  );
  return rows;
}

export async function getUntranslatedLeagues(): Promise<LeagueDictRow[]> {
  const [rows] = await pool.execute<LeagueDictRow[] & mysql.RowDataPacket[]>(
    `SELECT * FROM soccer_leagues WHERE name_zh IS NULL OR name_zh = '' ORDER BY name_en ASC`,
  );
  return rows;
}

export async function upsertLeague(nameEn: string, nameZh: string | null): Promise<void> {
  await pool.execute(
    `INSERT INTO soccer_leagues (name_en, name_zh)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE
       name_zh = COALESCE(VALUES(name_zh), name_zh)`,
    [nameEn.trim(), nameZh?.trim() || null],
  );
}

export async function updateLeague(id: number, nameZh: string): Promise<void> {
  await pool.execute(
    `UPDATE soccer_leagues SET name_zh = ? WHERE id = ?`,
    [nameZh.trim() || null, id],
  );
}

export async function deleteLeague(id: number): Promise<void> {
  await pool.execute(`DELETE FROM soccer_leagues WHERE id = ?`, [id]);
}

export async function getLeagueTranslationMap(): Promise<Record<string, string>> {
  const [rows] = await pool.execute<{ name_en: string; name_zh: string }[] & mysql.RowDataPacket[]>(
    `SELECT name_en, name_zh FROM soccer_leagues WHERE name_zh IS NOT NULL AND name_zh <> ''`,
  );
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.name_en] = row.name_zh;
  }
  return map;
}

// ---- Batch import ----

export async function batchImportTeams(teams: Array<{ name_en: string; name_zh?: string; league?: string }>): Promise<number> {
  if (!teams.length) return 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let count = 0;
    for (const t of teams) {
      if (!t.name_en?.trim()) continue;
      await conn.execute(
        `INSERT INTO soccer_teams (name_en, name_zh, league)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name_zh = COALESCE(VALUES(name_zh), name_zh),
           league = COALESCE(VALUES(league), league)`,
        [t.name_en.trim(), t.name_zh?.trim() || null, t.league?.trim() || null],
      );
      count++;
    }
    await conn.commit();
    return count;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function batchImportLeagues(leagues: Array<{ name_en: string; name_zh?: string }>): Promise<number> {
  if (!leagues.length) return 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let count = 0;
    for (const l of leagues) {
      if (!l.name_en?.trim()) continue;
      await conn.execute(
        `INSERT INTO soccer_leagues (name_en, name_zh)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE name_zh = COALESCE(VALUES(name_zh), name_zh)`,
        [l.name_en.trim(), l.name_zh?.trim() || null],
      );
      count++;
    }
    await conn.commit();
    return count;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---- Extract teams/leagues from existing events and populate dictionary ----

export async function syncDictFromEvents(): Promise<{ teams: number; leagues: number }> {
  const conn = await pool.getConnection();
  try {
    // Extract distinct leagues
    const [leagueRows] = await conn.query<{ league: string }[] & mysql.RowDataPacket[]>(
      `SELECT DISTINCT league FROM soccer_events WHERE league IS NOT NULL AND league <> ''`,
    );
    let leagueCount = 0;
    for (const row of leagueRows) {
      const [result] = await conn.execute<mysql.OkPacket>(
        `INSERT IGNORE INTO soccer_leagues (name_en) VALUES (?)`,
        [row.league],
      );
      leagueCount += result.affectedRows;
    }

    // Extract distinct home teams
    const [homeRows] = await conn.query<{ home_team_en: string; league: string | null }[] & mysql.RowDataPacket[]>(
      `SELECT DISTINCT home_team_en, league FROM soccer_events WHERE home_team_en IS NOT NULL AND home_team_en <> ''`,
    );
    // Extract distinct away teams
    const [awayRows] = await conn.query<{ away_team_en: string; league: string | null }[] & mysql.RowDataPacket[]>(
      `SELECT DISTINCT away_team_en, league FROM soccer_events WHERE away_team_en IS NOT NULL AND away_team_en <> ''`,
    );

    // Build map: normalized name -> { canonical name, leagues }
    const teamMap = new Map<string, { nameEn: string; leagues: Set<string> }>();
    function addTeam(rawName: string, league: string | null) {
      const trimmed = rawName.trim();
      const key = normalizeTeamName(trimmed);
      if (!teamMap.has(key)) {
        teamMap.set(key, { nameEn: trimmed, leagues: new Set() });
      }
      if (league) teamMap.get(key)!.leagues.add(league);
    }
    for (const row of homeRows) addTeam(row.home_team_en, row.league);
    for (const row of awayRows) addTeam(row.away_team_en, row.league);

    let teamCount = 0;
    for (const { nameEn, leagues } of teamMap.values()) {
      // Find existing canonical name to avoid duplicates
      const existingName = await findExistingTeamName(nameEn);
      const canonicalName = existingName || nameEn;
      const leagueStr = leagues.size > 0 ? Array.from(leagues)[0] : null;
      const [result] = await conn.execute<mysql.OkPacket>(
        `INSERT INTO soccer_teams (name_en, league)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE league = COALESCE(VALUES(league), league)`,
        [canonicalName, leagueStr],
      );
      teamCount += result.affectedRows;
    }

    return { teams: teamCount, leagues: leagueCount };
  } finally {
    conn.release();
  }
}

// ---- Deduplicate teams by normalized name ----

export async function deduplicateTeams(): Promise<{ merged: number; total: number }> {
  const conn = await pool.getConnection();
  try {
    // Find all teams, group by normalized name
    const [allTeams] = await conn.query<
      Array<{ id: number; name_en: string; name_zh: string | null; league: string | null }>
      & mysql.RowDataPacket[]
    >(`SELECT id, name_en, name_zh, league FROM soccer_teams ORDER BY id ASC`);

    const groups = new Map<string, Array<{ id: number; name_en: string; name_zh: string | null; league: string | null }>>();
    for (const team of allTeams) {
      const key = normalizeTeamName(team.name_en);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(team);
    }

    let mergedCount = 0;
    for (const group of groups.values()) {
      if (group.length <= 1) continue;

      // Keep the first entry as canonical; merge others into it
      const canonical = group[0];
      const duplicates = group.slice(1);

      // Merge translations: if canonical has no zh but a duplicate does, use it
      let bestZh = canonical.name_zh;
      let bestLeague = canonical.league;
      for (const dup of duplicates) {
        if (!bestZh && dup.name_zh) bestZh = dup.name_zh;
        if (!bestLeague && dup.league) bestLeague = dup.league;
      }

      // Update canonical with best values
      await conn.execute(
        `UPDATE soccer_teams SET name_zh = COALESCE(?, name_zh), league = COALESCE(?, league) WHERE id = ?`,
        [bestZh, bestLeague, canonical.id],
      );

      // Update events referencing duplicate names to use canonical name
      for (const dup of duplicates) {
        await conn.execute(
          `UPDATE soccer_events SET home_team_en = ? WHERE home_team_en = ?`,
          [canonical.name_en, dup.name_en],
        );
        await conn.execute(
          `UPDATE soccer_events SET away_team_en = ? WHERE away_team_en = ?`,
          [canonical.name_en, dup.name_en],
        );
        // Delete the duplicate
        await conn.execute(`DELETE FROM soccer_teams WHERE id = ?`, [dup.id]);
        mergedCount++;
      }
    }

    const [countResult] = await conn.query<Array<{ total: number }> & mysql.RowDataPacket[]>(
      `SELECT COUNT(*) as total FROM soccer_teams`,
    );
    return { merged: mergedCount, total: countResult[0]?.total ?? 0 };
  } finally {
    conn.release();
  }
}

// ---- Apply dictionary translations to existing events ----

export async function applyDictionaryToEvents(): Promise<{ events: number; markets: number }> {
  const [dbTeamMap, dbLeagueMap] = await Promise.all([
    getTeamTranslationMap(),
    getLeagueTranslationMap(),
  ]);
  const combinedTeamMap = { ...TEAM_NAME_MAP, ...dbTeamMap };

  const conn = await pool.getConnection();
  try {
    // Batch 1: Update home_team_zh via JOIN on soccer_teams
    await conn.execute(
      `UPDATE soccer_events e
       LEFT JOIN soccer_teams t ON e.home_team_en = t.name_en
       SET e.home_team_zh = COALESCE(t.name_zh, e.home_team_en)`,
    );

    // Batch 2: Update away_team_zh via JOIN
    await conn.execute(
      `UPDATE soccer_events e
       LEFT JOIN soccer_teams t ON e.away_team_en = t.name_en
       SET e.away_team_zh = COALESCE(t.name_zh, e.away_team_en)`,
    );

    // Batch 3: Update league via JOIN on soccer_leagues
    await conn.execute(
      `UPDATE soccer_events e
       LEFT JOIN soccer_leagues l ON e.league = l.name_en
       SET e.league = COALESCE(l.name_zh, e.league)`,
    );

    // Batch 4: Update title_zh from home_team_zh and away_team_zh
    await conn.execute(
      `UPDATE soccer_events
       SET title_zh = CASE
         WHEN home_team_zh IS NOT NULL AND away_team_zh IS NOT NULL
           THEN CONCAT(home_team_zh, ' vs ', away_team_zh)
         ELSE title_en
       END`,
    );

    // Batch 5: Update markets question_zh with in-memory translation
    // (can't do in SQL because translateText has complex logic)
    const [events] = await conn.query<
      Array<{
        id: string;
        home_team_en: string | null;
        away_team_en: string | null;
        home_team_zh: string | null;
        away_team_zh: string | null;
      }> & mysql.RowDataPacket[]
    >(
      `SELECT id, home_team_en, away_team_en, home_team_zh, away_team_zh FROM soccer_events
       WHERE home_team_en IS NOT NULL AND away_team_en IS NOT NULL`,
    );

    let marketCount = 0;
    for (const evt of events) {
      const homeEn = evt.home_team_en || '';
      const awayEn = evt.away_team_en || '';
      const homeZh = evt.home_team_zh || homeEn;
      const awayZh = evt.away_team_zh || awayEn;

      const [markets] = await conn.query<
        Array<{ id: string; question_en: string }> & mysql.RowDataPacket[]
      >(
        `SELECT id, question_en FROM soccer_markets WHERE event_id = ? AND question_zh IS NULL`,
        [evt.id],
      );

      if (!markets.length) continue;

      const updates: Array<[string, string]> = [];
      for (const mkt of markets) {
        const questionZh = translateText(mkt.question_en, homeEn, awayEn, homeZh, awayZh);
        updates.push([questionZh, mkt.id]);
      }

      for (const [zh, id] of updates) {
        await conn.execute(
          `UPDATE soccer_markets SET question_zh = ? WHERE id = ?`,
          [zh, id],
        );
        marketCount++;
      }
    }

    const [countResult] = await conn.query<
      Array<{ total: number }> & mysql.RowDataPacket[]
    >(`SELECT COUNT(*) as total FROM soccer_events`);

    return { events: countResult[0]?.total ?? 0, markets: marketCount };
  } finally {
    conn.release();
  }
}
