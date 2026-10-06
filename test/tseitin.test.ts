import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  validateFormula,
  convert,
  checkVarAssignment,
  extendAssignment,
  verifyFullAssignment,
  toDimacs,
  FormulaNode,
  ConversionResult,
} from "../src/tseitin";
import { ApiError } from "../src/errors";
import { Store } from "../src/store";

// 独立求值器：不经过转换器，直接对树求值
function evalFormula(n: FormulaNode, env: Record<string, boolean>): boolean {
  if (n.type === "var") return env[n.name];
  if (n.type === "not") return !evalFormula(n.child, env);
  if (n.type === "and") return evalFormula(n.left, env) && evalFormula(n.right, env);
  return evalFormula(n.left, env) || evalFormula(n.right, env);
}

function varNames(n: FormulaNode): string[] {
  const s = new Set<string>();
  (function walk(x: FormulaNode) {
    if (x.type === "var") s.add(x.name);
    else if (x.type === "not") walk(x.child);
    else {
      walk(x.left);
      walk(x.right);
    }
  })(n);
  return [...s].sort();
}

function clauseSat(lits: number[], asg: Map<number, boolean>): boolean {
  return lits.some((l) => asg.get(Math.abs(l)) === l > 0);
}

// 穷举原变量与全部辅助变量赋值，独立核对
function bruteForceCheck(formula: FormulaNode, result: ConversionResult): void {
  const names = varNames(formula);
  const nOrig = names.length;
  const nAux = result.numVars - nOrig;
  assert.ok(result.numVars <= 20, "公式太大不适合穷举");
  for (let bits = 0; bits < 1 << result.numVars; bits++) {
    const asg = new Map<number, boolean>();
    for (let i = 1; i <= result.numVars; i++) asg.set(i, !!((bits >> (i - 1)) & 1));
    const env: Record<string, boolean> = {};
    names.forEach((nm, i) => (env[nm] = asg.get(i + 1)!));
    const formulaVal = evalFormula(formula, env);
    const defClauses = result.clauses.filter((c) => c.source.kind === "def");
    const rootClause = result.clauses.find((c) => c.source.kind === "root")!;
    const defsSat = defClauses.every((c) => clauseSat(c.lits, asg));
    const fullSat = result.clauses.every((c) => clauseSat(c.lits, asg));
    // 完整 CNF 成立 当且仅当 定义子句满足且原公式为真
    assert.equal(fullSat, defsSat && formulaVal, `bits=${bits}`);
    // 根约束对应关系：定义满足时，根文字必等于公式真值
    if (defsSat) {
      assert.equal(clauseSat(rootClause.lits, asg), formulaVal);
    }
  }
  // 唯一扩展性：每组原变量赋值下，恰好有一个辅助赋值满足定义子句
  for (let vb = 0; vb < 1 << nOrig; vb++) {
    let count = 0;
    for (let ab = 0; ab < 1 << nAux; ab++) {
      const asg = new Map<number, boolean>();
      for (let i = 1; i <= nOrig; i++) asg.set(i, !!((vb >> (i - 1)) & 1));
      for (let i = 0; i < nAux; i++) asg.set(nOrig + 1 + i, !!((ab >> i) & 1));
      if (result.clauses.filter((c) => c.source.kind === "def").every((c) => clauseSat(c.lits, asg))) count++;
    }
    assert.equal(count, 1, `原变量赋值 ${vb} 下定义子句的满足扩展不唯一`);
  }
}

test("(a||b)&&!a 穷举验证", () => {
  const f = validateFormula({
    type: "and",
    left: { type: "or", left: { type: "var", name: "a" }, right: { type: "var", name: "b" } },
    right: { type: "not", child: { type: "var", name: "a" } },
  });
  const r = convert(f);
  assert.equal(r.numVars, 5); // 2 原变量 + 3 辅助
  assert.equal(r.numClauses, 3 + 2 + 3 + 1); // or 3, not 2, and 3, root 1
  bruteForceCheck(f, r);
  // 扩展后通过
  const va = checkVarAssignment(r, { a: false, b: true });
  const full = extendAssignment(f, r, va);
  assert.deepEqual(verifyFullAssignment(r, full), { ok: true });
  // 篡改 or 的辅助值 -> 报告失败子句及来源
  const orAux = r.nodes.find((n) => n.type === "or")!.auxId!;
  const bad = new Map(full);
  bad.set(orAux, !bad.get(orAux));
  const res = verifyFullAssignment(r, bad);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.source.kind, "def");
    assert.equal(res.source.nodeId, r.nodes.find((n) => n.type === "or")!.nodeId);
  }
});

test("x && !x 穷举验证（不可满足）", () => {
  const f = validateFormula({
    type: "and",
    left: { type: "var", name: "x" },
    right: { type: "not", child: { type: "var", name: "x" } },
  } as never);
  const r = convert(f);
  bruteForceCheck(f, r);
  for (const x of [false, true]) {
    const ext = extendAssignment(f, r, checkVarAssignment(r, { x }));
    const res = verifyFullAssignment(r, ext);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.source.kind, "root");
  }
});

test("单变量公式根为单位子句", () => {
  const f = validateFormula({ type: "var", name: "y" });
  const r = convert(f);
  assert.equal(r.numVars, 1);
  assert.equal(r.numClauses, 1);
  assert.deepEqual(r.clauses[0].lits, [1]);
  assert.equal(r.clauses[0].source.kind, "root");
  bruteForceCheck(f, r);
});

test("重复变量与重复子式各自独立引入辅助变量", () => {
  const sub: FormulaNode = { type: "and", left: { type: "var", name: "a" }, right: { type: "var", name: "a" } };
  const f = validateFormula({ type: "or", left: sub, right: sub });
  const r = convert(f);
  const andNodes = r.nodes.filter((n) => n.type === "and");
  assert.equal(andNodes.length, 2);
  assert.notEqual(andNodes[0].auxId, andNodes[1].auxId);
  bruteForceCheck(f, r);
});

test("深链与线性子句增长", () => {
  let f: FormulaNode = { type: "var", name: "a" };
  for (let i = 0; i < 50; i++) f = { type: "not", child: f };
  const r = convert(validateFormula(f));
  assert.equal(r.numClauses, 50 * 2 + 1);
  assert.equal(r.numVars, 51);
  // 混合二元链
  let g: FormulaNode = { type: "var", name: "a" };
  for (let i = 0; i < 30; i++) g = { type: "and", left: g, right: { type: "var", name: "a" } };
  const rg = convert(validateFormula(g));
  assert.equal(rg.numClauses, 30 * 3 + 1);
});

test("变量名 aux1 被拒绝，不与辅助变量碰撞", () => {
  assert.throws(() => validateFormula({ type: "var", name: "aux1" }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal((e as ApiError).code, "INVALID_VAR_NAME");
    return true;
  });
  // 普通名字不受影响，辅助 ID 与原变量 ID 区间分离
  const f = validateFormula({ type: "not", child: { type: "var", name: "aux" } });
  const r = convert(f);
  assert.equal(r.variables[0].id, 1);
  assert.equal(r.nodes.find((n) => n.auxId !== null)!.auxId, 2);
});

test("非法节点与元数校验", () => {
  assert.throws(() => validateFormula({ type: "xor", left: {}, right: {} }), /未知节点类型/);
  assert.throws(
    () => validateFormula({ type: "and", left: { type: "var", name: "a" } }),
    (e: unknown) => (e as ApiError).code === "INVALID_ARITY"
  );
  assert.throws(
    () => validateFormula({ type: "not", child: { type: "var", name: "a" }, extra: 1 }),
    (e: unknown) => (e as ApiError).code === "INVALID_ARITY"
  );
  assert.throws(() => validateFormula({ type: "var", name: "1bad" }), (e: unknown) => (e as ApiError).code === "INVALID_VAR_NAME");
  assert.throws(() => validateFormula(null), (e: unknown) => (e as ApiError).code === "INVALID_NODE");
});

test("节点数与深度限制", () => {
  let deep: FormulaNode = { type: "var", name: "a" };
  for (let i = 0; i < 600; i++) deep = { type: "not", child: deep };
  assert.throws(() => validateFormula(deep), (e: unknown) => (e as ApiError).code === "TOO_DEEP");
});

test("赋值校验：缺失与非布尔", () => {
  const f = validateFormula({ type: "and", left: { type: "var", name: "a" }, right: { type: "var", name: "b" } });
  const r = convert(f);
  assert.throws(() => checkVarAssignment(r, { a: true }), (e: unknown) => (e as ApiError).code === "MISSING_ASSIGNMENT");
  assert.throws(
    () => checkVarAssignment(r, { a: true, b: 1 }),
    (e: unknown) => (e as ApiError).code === "NON_BOOLEAN_ASSIGNMENT"
  );
  assert.throws(
    () => verifyFullAssignment(r, new Map([[1, true]])),
    (e: unknown) => (e as ApiError).code === "MISSING_ASSIGNMENT"
  );
});

test("DIMACS 变量数与子句数一致", () => {
  const f = validateFormula({
    type: "or",
    left: { type: "and", left: { type: "var", name: "p" }, right: { type: "var", name: "q" } },
    right: { type: "not", child: { type: "var", name: "p" } },
  });
  const r = convert(f);
  const text = toDimacs(r);
  const header = text.split("\n").find((l) => l.startsWith("p cnf"))!;
  const [, , nv, nc] = header.split(" ");
  assert.equal(Number(nv), r.numVars);
  assert.equal(Number(nc), r.numClauses);
  const clauseLines = text.split("\n").filter((l) => l.endsWith(" 0"));
  assert.equal(clauseLines.length, r.numClauses);
  const maxLit = Math.max(...r.clauses.flatMap((c) => c.lits.map(Math.abs)));
  assert.equal(maxLit, r.numVars);
  bruteForceCheck(f, r);
});

test("SQLite 持久化：版本递增与重启后查询", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "data-test-"));
  const dbPath = path.join(dir, "t.db");
  const f1 = validateFormula({ type: "var", name: "a" });
  const f2 = validateFormula({ type: "not", child: { type: "var", name: "a" } });
  let id1: number, id2: number;
  {
    const s = new Store(dbPath);
    id1 = s.saveConversion("f", f1, convert(f1)).id;
    id2 = s.saveConversion("f", f2, convert(f2)).id;
    s.close();
  }
  {
    // 模拟重启：重新打开数据库
    const s = new Store(dbPath);
    const c1 = s.getConversion(id1);
    const c2 = s.getConversion(id2);
    assert.equal(c1.version, 1);
    assert.equal(c2.version, 2);
    assert.deepEqual(c1.result, convert(f1));
    assert.deepEqual(c2.result, convert(f2));
    const h = s.history();
    assert.equal(h.length, 2);
    assert.throws(() => s.getConversion(999), (e: unknown) => (e as ApiError).code === "NOT_FOUND");
    s.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("复杂公式穷举验证", () => {
  const f = validateFormula({
    type: "or",
    left: { type: "and", left: { type: "var", name: "a" }, right: { type: "not", child: { type: "var", name: "b" } } },
    right: { type: "or", left: { type: "var", name: "c" }, right: { type: "and", left: { type: "var", name: "b" }, right: { type: "var", name: "a" } } },
  });
  bruteForceCheck(f, convert(f));
});
