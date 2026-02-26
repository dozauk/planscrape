import Database from 'better-sqlite3';
import { Application, CouncilId } from './types';

export interface ScrapeStatus {
  council: string;
  last_success: string | null;
  last_run: string | null;
}

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      council TEXT NOT NULL,
      applreference TEXT NOT NULL,
      address TEXT,
      description TEXT,
      datereceived TEXT,
      datevalidated TEXT,
      status TEXT,
      decision TEXT,
      decision_date TEXT,
      appeal_decision TEXT,
      appeal_date TEXT,
      detailsurl TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      UNIQUE(council, applreference)
    );
    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      council TEXT NOT NULL,
      run_at TEXT NOT NULL,
      success INTEGER NOT NULL,
      count INTEGER,
      error TEXT
    );
  `);
  return db;
}

export function upsertApplications(db: Database.Database, apps: Application[]): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO applications (
      id, council, applreference, address, description,
      datereceived, datevalidated, status, decision, decision_date,
      appeal_decision, appeal_date, detailsurl, first_seen, last_seen
    ) VALUES (
      @id, @council, @applreference, @address, @description,
      @datereceived, @datevalidated, @status, @decision, @decision_date,
      @appeal_decision, @appeal_date, @detailsurl, @first_seen, @last_seen
    )
    ON CONFLICT(council, applreference) DO UPDATE SET
      address        = excluded.address,
      description    = excluded.description,
      datereceived   = excluded.datereceived,
      datevalidated  = excluded.datevalidated,
      status         = excluded.status,
      decision       = excluded.decision,
      decision_date  = excluded.decision_date,
      appeal_decision = excluded.appeal_decision,
      appeal_date    = excluded.appeal_date,
      detailsurl     = excluded.detailsurl,
      last_seen      = excluded.last_seen
  `);

  const upsertAll = db.transaction((rows: Application[]) => {
    for (const app of rows) {
      stmt.run({
        id: `${app.council}:${app.applreference}`,
        council: app.council,
        applreference: app.applreference,
        address: app.address ?? null,
        description: app.description ?? null,
        datereceived: app.datereceived ?? null,
        datevalidated: app.datevalidated ?? null,
        status: app.status ?? null,
        decision: app.decision ?? null,
        decision_date: app.decision_date ?? null,
        appeal_decision: app.appeal_decision ?? null,
        appeal_date: app.appeal_date ?? null,
        detailsurl: app.detailsurl,
        first_seen: now,
        last_seen: now,
      });
    }
  });

  upsertAll(apps);
}

export function logScrapeRun(
  db: Database.Database,
  council: string,
  success: boolean,
  count: number | null,
  error: string | null,
): void {
  db.prepare(`
    INSERT INTO scrape_runs (council, run_at, success, count, error)
    VALUES (?, ?, ?, ?, ?)
  `).run(council, new Date().toISOString(), success ? 1 : 0, count, error);
}

export function getScrapeStatus(db: Database.Database): ScrapeStatus[] {
  return db.prepare(`
    SELECT
      council,
      MAX(CASE WHEN success = 1 THEN run_at END) AS last_success,
      MAX(run_at) AS last_run
    FROM scrape_runs
    GROUP BY council
    ORDER BY council
  `).all() as ScrapeStatus[];
}

export function getRecentApplications(db: Database.Database, days: number): Application[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return db.prepare(`
    SELECT * FROM applications
    WHERE decision_date >= @cutoff OR appeal_date >= @cutoff
    ORDER BY COALESCE(appeal_date, decision_date) DESC, datevalidated DESC
  `).all({ cutoff: cutoffStr }) as Application[];
}

export function getApplicationsForDigest(db: Database.Database, days: number): Application[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return db.prepare(`
    SELECT * FROM applications
    WHERE decision_date >= @cutoff OR appeal_date >= @cutoff
    ORDER BY council, COALESCE(appeal_date, decision_date) DESC
  `).all({ cutoff: cutoffStr }) as Application[];
}
