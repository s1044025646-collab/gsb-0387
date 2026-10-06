import * as fs from "node:fs";
import { Store, defaultDbPath } from "./store";
import {
  validateFormula,
  convert,
  checkVarAssignment,
  extendAssignment,
  verifyFullAssignment,
  toDimacs,
} from "./tseitin";
import { ApiError } from "./errors";

function usage(): void {
  console.log(`用法: node dist/src/cli.js <命令> [参数]

命令:
  import <formula.json> [--name=名称]   导入公式并转换（同名创建新版本）
  show <id>                             查看转换结果（变量表/节点映射/子句/根约束）
  extend <id> <assign.json>             由原变量赋值扩展出完整赋值
  verify <id> <full-assign.json>        核验完整赋值（键为变量 ID）
  dimacs <id> [out.cnf]                 导出 DIMACS
  history                               查询历史记录
  demo                                  运行演示

assign.json 示例: {"a": false, "b": true}
full-assign.json 示例: {"1": false, "2": true, "3": true}`);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(process.env.DB_PATH ?? defaultDbPath());
  try {
    switch (cmd) {
      case "import": {
        const file = args[0];
        if (!file) throw new ApiError("BAD_REQUEST", "缺少公式 JSON 文件路径");
        const nameArg = args.find((a) => a.startsWith("--name="));
        const name = nameArg ? nameArg.split("=")[1] : `formula-${Date.now()}`;
        const formula = validateFormula(readJson(file));
        const result = convert(formula);
        const saved = store.saveConversion(name, formula, result);
        console.log(JSON.stringify({ id: saved.id, name: saved.formulaName, version: saved.version, numVars: result.numVars, numClauses: result.numClauses }, null, 2));
        break;
      }
      case "show": {
        const c = store.getConversion(Number(args[0]));
        console.log(JSON.stringify(c, null, 2));
        break;
      }
      case "extend": {
        const c = store.getConversion(Number(args[0]));
        const varAssign = checkVarAssignment(c.result, readJson(args[1]) as Record<string, unknown>);
        const full = extendAssignment(c.formula, c.result, varAssign);
        console.log(JSON.stringify(Object.fromEntries(full), null, 2));
        break;
      }
      case "verify": {
        const c = store.getConversion(Number(args[0]));
        const raw = readJson(args[1]) as Record<string, unknown>;
        const full = new Map<number, boolean>();
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v !== "boolean") throw new ApiError("NON_BOOLEAN_ASSIGNMENT", `变量 ${k} 的赋值不是布尔值`);
          full.set(Number(k), v);
        }
        console.log(JSON.stringify(verifyFullAssignment(c.result, full), null, 2));
        break;
      }
      case "dimacs": {
        const c = store.getConversion(Number(args[0]));
        const text = toDimacs(c.result);
        if (args[1]) {
          fs.writeFileSync(args[1], text);
          console.log(`已写入 ${args[1]}`);
        } else {
          process.stdout.write(text);
        }
        break;
      }
      case "history": {
        console.log(JSON.stringify(store.history(), null, 2));
        break;
      }
      default:
        usage();
        if (cmd) process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`错误 [${e.code}] ${e.message}`);
      process.exitCode = 1;
    } else {
      throw e;
    }
  } finally {
    store.close();
  }
}

main();
