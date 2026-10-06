import { validateFormula, convert, checkVarAssignment, extendAssignment, verifyFullAssignment, toDimacs } from "./tseitin";

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

section("演示 1: (a || b) && !a，a=false, b=true");
const f1 = validateFormula({
  type: "and",
  left: { type: "or", left: { type: "var", name: "a" }, right: { type: "var", name: "b" } },
  right: { type: "not", child: { type: "var", name: "a" } },
});
const r1 = convert(f1);
console.log("变量表:", r1.variables);
console.log("节点映射:", r1.nodes);
console.log(toDimacs(r1));

const varAssign = checkVarAssignment(r1, { a: false, b: true });
const full = extendAssignment(f1, r1, varAssign);
console.log("扩展后的完整赋值:", Object.fromEntries(full));
console.log("核验结果:", verifyFullAssignment(r1, full));

const orAux = r1.nodes.find((n) => n.type === "or")!.auxId!;
const tampered = new Map(full);
tampered.set(orAux, !tampered.get(orAux));
console.log(`篡改 aux${orAux} 后的核验结果:`, verifyFullAssignment(r1, tampered));

section("演示 2: x && !x");
const f2 = validateFormula({
  type: "and",
  left: { type: "var", name: "x" },
  right: { type: "not", child: { type: "var", name: "x" } },
});
const r2 = convert(f2);
console.log(toDimacs(r2));
for (const x of [false, true]) {
  const va = checkVarAssignment(r2, { x });
  const ext = extendAssignment(f2, r2, va);
  console.log(`x=${x} 扩展 ${JSON.stringify(Object.fromEntries(ext))} 核验:`, verifyFullAssignment(r2, ext));
}

section("演示 3: 单变量公式 y");
const f3 = validateFormula({ type: "var", name: "y" });
const r3 = convert(f3);
console.log(toDimacs(r3));
const ext3 = extendAssignment(f3, r3, checkVarAssignment(r3, { y: true }));
console.log("y=true 核验:", verifyFullAssignment(r3, ext3));
