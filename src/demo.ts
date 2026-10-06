// 演示：(a|b)&!a 的扩展与核验、x&!x、单变量公式
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "./db.ts";
import { extendAssignment, toDimacs, verifyAssignment } from "./tseitin.ts";

const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), "tseitin-demo-")), "demo.db"));

function show(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// 1. (a 或 b) 且 非 a
show("(a 或 b) 且 非 a");
const f1 = {
  type: "and",
  left: { type: "or", left: { type: "var", name: "a" }, right: { type: "var", name: "b" } },
  right: { type: "not", child: { type: "var", name: "a" } },
} as const;
const r1 = store.save("demo1", f1 as never);
console.log("变量表:", r1.result.variables);
console.log("节点->辅助ID:", r1.result.nodes.filter((n) => n.auxId).map((n) => `节点${n.nodeId}:${n.detail}->z${n.auxId}`));
console.log("子句:");
for (const c of r1.result.clauses)
  console.log(`  [${c.literals.join(" ")}]  <- ${c.source.kind} 节点${c.source.nodeId} ${c.source.description}`);

const ext = extendAssignment(r1.formula, r1.result, { a: false, b: true });
console.log("a=false,b=true 扩展赋值:", ext);
console.log("核验扩展赋值:", verifyAssignment(r1.result, ext));

const tampered = { ...ext };
const auxIds = Object.keys(ext).map(Number).filter((id) => id >= r1.result.auxStart);
tampered[auxIds[0]] = !tampered[auxIds[0]];
console.log(`篡改关键辅助变量 z${auxIds[0]} 后核验:`, verifyAssignment(r1.result, tampered));

// 2. x 且 非 x
show("x 且 非 x（不可满足，根约束必失败）");
const f2 = {
  type: "and",
  left: { type: "var", name: "x" },
  right: { type: "not", child: { type: "var", name: "x" } },
} as const;
const r2 = store.save("demo2", f2 as never);
for (const x of [false, true]) {
  const e = extendAssignment(r2.formula, r2.result, { x });
  console.log(`x=${x} 扩展:`, e, "核验:", verifyAssignment(r2.result, e));
}

// 3. 单变量公式
show("单变量公式 y（根即变量，直接单位子句）");
const r3 = store.save("demo3", { type: "var", name: "y" } as never);
console.log("子句:", r3.result.clauses);
console.log("DIMACS:\n" + toDimacs(r3.result));

store.close();
