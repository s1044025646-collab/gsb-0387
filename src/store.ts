import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConversionResult, FormulaNode } from "./tseitin";
import { ApiError } from "./errors";

export interface StoredConversion {
  id: number;
  formulaName: string;
  version: number;
  formula: FormulaNode;
  result: ConversionResult;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS formulas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        formula_id INTEGER NOT NULL REFERENCES formulas(id),
        version INTEGER NOT NULL,
        formula_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(formula_id, version)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  saveConversion(name: string, formula: FormulaNode, result: ConversionResult): StoredConversion {
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO formulas(name, created_at) VALUES (?, ?)").run(name, now);
    const f = this.db.prepare("SELECT id FROM formulas WHERE name = ?").get(name) as { id: number };
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM conversions WHERE formula_id = ?")
      .get(f.id) as { v: number };
    const version = row.v + 1;
    const info = this.db
      .prepare(
        "INSERT INTO conversions(formula_id, version, formula_json, result_json, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(f.id, version, JSON.stringify(formula), JSON.stringify(result), now);
    return {
      id: Number(info.lastInsertRowid),
      formulaName: name,
      version,
      formula,
      result,
      createdAt: now,
    };
  }

  getConversion(id: number): StoredConversion {
    const row = this.db
      .prepare(
        `SELECT c.id, f.name AS fname, c.version, c.formula_json, c.result_json, c.created_at
         FROM conversions c JOIN formulas f ON f.id = c.formula_id WHERE c.id = ?`
      )
      .get(id) as
      | { id: number; fname: string; version: number; formula_json: string; result_json: string; created_at: string }
      | undefined;
    if (!row) throw new ApiError("NOT_FOUND", `转换记录 ${id} 不存在`, 404);
    return {
      id: row.id,
      formulaName: row.fname,
      version: row.version,
      formula: JSON.parse(row.formula_json),
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    };
  }

  history(): { id: number; formulaName: string; version: number; numVars: number; numClauses: number; createdAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, f.name AS fname, c.version, c.result_json, c.created_at
         FROM conversions c JOIN formulas f ON f.id = c.formula_id ORDER BY c.id`
      )
      .all() as { id: number; fname: string; version: number; result_json: string; created_at: string }[];
    return rows.map((r) => {
      const res = JSON.parse(r.result_json) as ConversionResult;
      return {
        id: r.id,
        formulaName: r.fname,
        version: r.version,
        numVars: res.numVars,
        numClauses: res.numClauses,
        createdAt: r.created_at,
      };
    });
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "tseitin.db");
}
