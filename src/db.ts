// SQLite 持久化：公式版本、编号规则与转换结果
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { FormulaNode, TseitinResult } from "./tseitin.ts";
import { tseitin } from "./tseitin.ts";

export interface FormulaRecord {
  id: number;
  name: string;
  version: number;
  formula: FormulaNode;
  result: TseitinResult;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS formulas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        formula_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, version)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // 保存公式：同名则创建新版本，重新计算 Tseitin 结果
  save(name: string, formula: FormulaNode): FormulaRecord {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM formulas WHERE name = ?")
      .get(name) as { v: number | null };
    const version = (row.v ?? 0) + 1;
    const result = tseitin(formula);
    const stmt = this.db.prepare(
      "INSERT INTO formulas (name, version, formula_json, result_json) VALUES (?, ?, ?, ?)",
    );
    const info = stmt.run(name, version, JSON.stringify(formula), JSON.stringify(result));
    return {
      id: Number(info.lastInsertRowid),
      name,
      version,
      formula,
      result,
      createdAt: new Date().toISOString(),
    };
  }

  get(name: string, version?: number): FormulaRecord | null {
    const row = (
      version === undefined
        ? this.db
            .prepare("SELECT * FROM formulas WHERE name = ? ORDER BY version DESC LIMIT 1")
            .get(name)
        : this.db.prepare("SELECT * FROM formulas WHERE name = ? AND version = ?").get(name, version)
    ) as { id: number; name: string; version: number; formula_json: string; result_json: string; created_at: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      formula: JSON.parse(row.formula_json),
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    };
  }

  history(name?: string): { name: string; version: number; createdAt: string }[] {
    const rows = (
      name === undefined
        ? this.db.prepare("SELECT name, version, created_at FROM formulas ORDER BY id").all()
        : this.db.prepare("SELECT name, version, created_at FROM formulas WHERE name = ? ORDER BY version").all(name)
    ) as { name: string; version: number; created_at: string }[];
    return rows.map((r) => ({ name: r.name, version: r.version, createdAt: r.created_at }));
  }
}
