import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FormulaError,
  MAX_DEPTH,
  evaluate,
  extendAssignment,
  toDimacs,
  tseitin,
  validateFormula,
  verifyAssignment,
  type FormulaNode,
} from "../src/tseitin.ts";
import { Store } from "../src/db.ts";

const v = (name: string): FormulaNode => ({ type: "var", name });
const not = (child: FormulaNode): FormulaNode => ({ type: "not", child });
const and = (left: FormulaNode, right: FormulaNode): FormulaNode => ({ type: "and", left, right });
const or = (left: FormulaNode, right: FormulaNode): FormulaNode => ({ type: "or", left, right });

// 独立暴力枚举：不调用转换器的求值器，直接按位枚举所有原变量+辅助赋值
function bruteForceCheck(f: FormulaNode) {
  const r = tseitin(f);
  const nVar = r.variables.length;
  const nAux = r.varCount - nVar;
  assert.ok(nVar + nAux <= 20, "枚举规模过大");
  const satCombos = new Set<string>();
  for (let mask = 0; mask < 1 << r.varCount; mask++) {
    const a = (id: number) => Boolean((mask >> (id - 1)) & 1);
    const ok = r.clauses.every((c) => c.literals.some((lit) => a(Math.abs(lit)) === lit > 0));
    if (ok) satCombos.add([...Array(nVar)].map((_, i) => (a(i + 1) ? 1 : 0)).join(""));
  }
  // 每个原变量赋值：定义子句的辅助扩展唯一，且加根约束后 CNF 可满足 <=> 原公式为真
  for (let mask = 0; mask < 1 << nVar; mask++) {
    const env: Record<string, boolean> = {};
    r.variables.forEach(({ name }, i) => (env[name] = Boolean((mask >> i) & 1)));
    const key = r.variables.map((_, i) => (env[_.name] ? 1 : 0)).join("");
    const origValue = evaluate(f, env);
    assert.equal(satCombos.has(key), origValue, `等可满足性不符 env=${JSON.stringify(env)}`);
    // 唯一扩展：extendAssignment 给出的赋值满足全部定义子句
    const ext = extendAssignment(f, r, env);
    const defClauses = r.clauses.filter((c) => c.source.kind === "definition");
    assert.ok(defClauses.every((c) => c.literals.some((lit) => ext[Math.abs(lit)] === lit > 0)));
    // 唯一性：翻转任一辅助位必破坏某个定义子句
    for (let aux = r.auxStart; aux <= r.varCount; aux++) {
      const t = { ...ext, [aux]: !ext[aux] };
      assert.ok(
        defClauses.some((c) => !c.literals.some((lit) => t[Math.abs(lit)] === lit > 0)),
        `辅助扩展不唯一 aux=${aux}`,
      );
    }
  }
}

test("暴力枚举交叉验证多个小公式", () => {
  bruteForceCheck(and(or(v("a"), v("b")), not(v("a"))));
  bruteForceCheck(and(v("x"), not(v("x"))));
  bruteForceCheck(v("y"));
  bruteForceCheck(or(and(v("a"), not(v("b"))), or(not(v("a")), v("b"))));
  bruteForceCheck(not(not(v("z"))));
});

test("and/or/not 双向约束子句形状", () => {
  const r = tseitin(and(v("a"), v("b")));
  // z3 <-> a&b: (-3 1)(-3 2)(3 -1 -2) + 根 (3)
  assert.deepEqual(
    r.clauses.map((c) => c.literals),
    [[-3, 1], [-3, 2], [3, -1, -2], [3]],
  );
  const r2 = tseitin(or(v("a"), v("b")));
  assert.deepEqual(
    r2.clauses.map((c) => c.literals),
    [[-3, 1, 2], [3, -1], [3, -2], [3]],
  );
  const r3 = tseitin(not(v("a")));
  assert.deepEqual(
    r3.clauses.map((c) => c.literals),
    [[2, 1], [-2, -1], [2]],
  );
});

test("变量按名称稳定排序，辅助 ID 与原变量分离", () => {
  const r = tseitin(and(v("zz"), v("aa")));
  assert.deepEqual(r.variables, [{ name: "aa", id: 1 }, { name: "zz", id: 2 }]);
  assert.equal(r.auxStart, 3);
});

test("用户变量叫 aux1 也不碰撞", () => {
  const r = tseitin(and(v("aux1"), v("b")));
  assert.equal(r.variables.find((x) => x.name === "aux1")!.id <= 2, true);
  assert.ok(r.auxStart > 2);
  const ext = extendAssignment(and(v("aux1"), v("b")), r, { aux1: true, b: true });
  assert.equal(verifyAssignment(r, ext).ok, true);
});

test("重复变量与重复子式各自独立引入辅助变量", () => {
  const sub = or(v("a"), v("b"));
  const r = tseitin(and(sub, sub));
  // 3 个操作节点 -> 3 个辅助，9 条定义子句 + 1 根
  assert.equal(r.varCount, 2 + 3);
  assert.equal(r.clauses.length, 10);
});

test("子句数随操作节点线性增长", () => {
  const count = (n: number) => {
    let f: FormulaNode = v("a");
    for (let i = 0; i < n; i++) f = and(f, v("a"));
    return tseitin(f).clauses.length;
  };
  assert.equal(count(5) - count(4), 3); // 每个 and 节点恰好 +3 子句
});

test("深链（不超过上限）可转换", () => {
  let f: FormulaNode = v("a");
  for (let i = 0; i < 100; i++) f = not(f);
  const r = tseitin(f);
  assert.equal(r.varCount, 1 + 100);
});

test("超过深度/节点上限报错", () => {
  let f: FormulaNode = v("a");
  for (let i = 0; i < MAX_DEPTH + 1; i++) f = not(f);
  assert.throws(() => validateFormula(f), (e: unknown) => e instanceof FormulaError && e.code === "E_TOO_DEEP");
});

test("非法节点与非法变量名报错，不产生半份 CNF", () => {
  assert.throws(() => tseitin({ type: "xor" } as never), /未知节点类型/);
  assert.throws(() => tseitin({ type: "var", name: "1bad" } as never), /非法变量名/);
  assert.throws(() => tseitin({ type: "and", left: v("a") } as never), /2 个操作数/);
  assert.throws(() => tseitin({ type: "not" } as never), /child/);
});

test("缺失/非布尔赋值报错", () => {
  const f = and(v("a"), v("b"));
  const r = tseitin(f);
  assert.throws(() => extendAssignment(f, r, { a: true } as never), /缺少赋值/);
  assert.throws(() => extendAssignment(f, r, { a: 1, b: true } as never), /非布尔/);
  assert.throws(() => verifyAssignment(r, { 1: true } as never), /缺少赋值/);
});

test("核验报告第一个不满足子句及来源，不偷偷改正", () => {
  const f = and(or(v("a"), v("b")), not(v("a")));
  const r = tseitin(f);
  const ext = extendAssignment(f, r, { a: false, b: true });
  assert.equal(verifyAssignment(r, ext).ok, true);
  const bad = { ...ext, [r.auxStart]: !ext[r.auxStart] };
  const out = verifyAssignment(r, bad);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.clause.source.kind, "definition");
    assert.match(out.reason, /节点/);
  }
});

test("DIMACS 头与内容一致", () => {
  const r = tseitin(and(v("a"), not(v("a"))));
  const lines = toDimacs(r).trim().split("\n");
  const header = lines.find((l) => l.startsWith("p cnf"))!;
  const [, , nv, nc] = header.split(" ").map(Number);
  assert.equal(nv, r.varCount);
  assert.equal(nc, r.clauses.length);
  assert.equal(lines.filter((l) => l.endsWith(" 0")).length, r.clauses.length);
});

test("SQLite 版本管理与重启后查询", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "tseitin-test-")), "t.db");
  let store = new Store(dbPath);
  store.save("f", and(v("a"), v("b")));
  store.save("f", or(v("a"), v("b")));
  store.save("g", v("c"));
  assert.deepEqual(store.history("f").map((h) => h.version), [1, 2]);
  assert.equal(store.history().length, 3);
  const before = store.get("f", 1)!;
  store.close();
  // 模拟重启
  store = new Store(dbPath);
  const after = store.get("f", 1)!;
  assert.deepEqual(after.result, before.result);
  assert.equal(store.get("f")!.version, 2); // 默认取最新
  assert.equal(store.get("missing"), null);
  store.close();
});
