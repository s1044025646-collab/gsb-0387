// CLI：导入、转换、查看、扩展、核验、导出 DIMACS、查询历史
import { readFileSync } from "node:fs";
import path from "node:path";
import { Store } from "./db.ts";
import {
  FormulaError,
  extendAssignment,
  toDimacs,
  tseitin,
  validateFormula,
  verifyAssignment,
} from "./tseitin.ts";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const store = new Store(path.join(DATA_DIR, "tseitin.db"));

function fail(e: unknown): never {
  if (e instanceof FormulaError) {
    console.error(`错误 [${e.code}] ${e.message}`);
  } else {
    console.error(`错误 ${(e as Error).message}`);
  }
  process.exit(1);
}

function readJson(arg: string): unknown {
  try {
    return JSON.parse(readFileSync(arg, "utf8"));
  } catch {
    try {
      return JSON.parse(arg);
    } catch {
      throw new FormulaError("E_BAD_JSON", `无法解析 JSON（既不是文件也不是 JSON 字符串）: ${arg}`);
    }
  }
}

const [cmd, ...args] = process.argv.slice(2);

function usage(): void {
  console.log(`用法:
  npm run cli -- import <name> <formula.json|JSON串>   导入公式（同名自动创建新版本）
  npm run cli -- convert <formula.json|JSON串>         一次性转换（不落库）
  npm run cli -- show <name> [version]                 读取节点与子句
  npm run cli -- extend <name> <assignment.json>       扩展原变量赋值（{"a":false,...}）
  npm run cli -- verify <name> <assignment.json>       核验完整赋值（{"1":true,...}）
  npm run cli -- dimacs <name>                         导出 DIMACS
  npm run cli -- history [name]                        查询历史`);
}

try {
  switch (cmd) {
    case "import": {
      const [name, src] = args;
      if (!name || !src) throw new FormulaError("E_USAGE", "import 需要 <name> <formula>");
      const formula = readJson(src);
      validateFormula(formula);
      const rec = store.save(name, formula);
      console.log(JSON.stringify({ name: rec.name, version: rec.version, result: rec.result }, null, 2));
      break;
    }
    case "convert": {
      const formula = readJson(args[0]);
      validateFormula(formula);
      console.log(JSON.stringify(tseitin(formula), null, 2));
      break;
    }
    case "show": {
      const rec = store.get(args[0], args[1] ? Number(args[1]) : undefined);
      if (!rec) throw new FormulaError("E_NOT_FOUND", "公式不存在");
      console.log(JSON.stringify({ name: rec.name, version: rec.version, formula: rec.formula, result: rec.result }, null, 2));
      break;
    }
    case "extend": {
      const rec = store.get(args[0]);
      if (!rec) throw new FormulaError("E_NOT_FOUND", "公式不存在");
      const env = readJson(args[1]) as Record<string, boolean>;
      console.log(JSON.stringify({ assignment: extendAssignment(rec.formula, rec.result, env) }, null, 2));
      break;
    }
    case "verify": {
      const rec = store.get(args[0]);
      if (!rec) throw new FormulaError("E_NOT_FOUND", "公式不存在");
      const asn = readJson(args[1]) as Record<number, boolean>;
      const out = verifyAssignment(rec.result, asn);
      console.log(JSON.stringify(out, null, 2));
      if (!out.ok) process.exit(2);
      break;
    }
    case "dimacs": {
      const rec = store.get(args[0]);
      if (!rec) throw new FormulaError("E_NOT_FOUND", "公式不存在");
      process.stdout.write(toDimacs(rec.result));
      break;
    }
    case "history":
      console.log(JSON.stringify(store.history(args[0]), null, 2));
      break;
    default:
      usage();
      if (cmd) process.exit(1);
  }
} catch (e) {
  fail(e);
} finally {
  store.close();
}
