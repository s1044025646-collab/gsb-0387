// Tseitin 转换核心：JSON 公式树 -> 线性规模 CNF

export type FormulaNode =
  | { type: "var"; name: string }
  | { type: "not"; child: FormulaNode }
  | { type: "and"; left: FormulaNode; right: FormulaNode }
  | { type: "or"; left: FormulaNode; right: FormulaNode };

export interface ClauseSource {
  nodeId: number; // 产生该子句的节点编号（后序）
  kind: "definition" | "root";
  description: string; // 例如 "z3 <-> (and z1 z2)"
}

export interface Clause {
  literals: number[]; // 带符号整数，0 非法
  source: ClauseSource;
}

export interface NodeInfo {
  nodeId: number; // 固定左右后序编号，从 1 开始
  type: "var" | "not" | "and" | "or";
  detail: string; // 变量名或操作符
  auxId: number | null; // 操作节点的辅助变量 ID；var 节点为 null
  varId: number | null; // var 节点对应的原变量 ID
}

export interface TseitinResult {
  variables: { name: string; id: number }[]; // 按名称稳定排序
  nodes: NodeInfo[];
  clauses: Clause[];
  rootLiteral: number; // 根单位子句文字
  varCount: number; // 原变量数 + 辅助变量数
  auxStart: number; // 第一个辅助变量 ID
}

export const MAX_NODES = 10000;
export const MAX_DEPTH = 500;

export class FormulaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FormulaError";
    this.code = code;
  }
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateFormula(node: unknown, depth = 1, counter = { n: 0 }): asserts node is FormulaNode {
  counter.n++;
  if (counter.n > MAX_NODES) throw new FormulaError("E_TOO_MANY_NODES", `节点数超过上限 ${MAX_NODES}`);
  if (depth > MAX_DEPTH) throw new FormulaError("E_TOO_DEEP", `嵌套深度超过上限 ${MAX_DEPTH}`);
  if (typeof node !== "object" || node === null || Array.isArray(node))
    throw new FormulaError("E_BAD_NODE", "节点必须是对象");
  const n = node as Record<string, unknown>;
  switch (n.type) {
    case "var":
      if (typeof n.name !== "string" || !NAME_RE.test(n.name))
        throw new FormulaError("E_BAD_VAR_NAME", `非法变量名: ${JSON.stringify(n.name)}`);
      break;
    case "not":
      if (!("child" in n)) throw new FormulaError("E_ARITY", "not 需要恰好 1 个子操作数 child");
      validateFormula(n.child, depth + 1, counter);
      break;
    case "and":
    case "or":
      if (!("left" in n) || !("right" in n))
        throw new FormulaError("E_ARITY", `${n.type} 需要恰好 2 个操作数 left/right`);
      validateFormula(n.left, depth + 1, counter);
      validateFormula(n.right, depth + 1, counter);
      break;
    default:
      throw new FormulaError("E_BAD_TYPE", `未知节点类型: ${JSON.stringify(n.type)}`);
  }
}

// 固定左右后序遍历，为每个节点编号
function postOrder(node: FormulaNode, out: FormulaNode[] = []): FormulaNode[] {
  if (node.type === "not") postOrder(node.child, out);
  else if (node.type === "and" || node.type === "or") {
    postOrder(node.left, out);
    postOrder(node.right, out);
  }
  out.push(node);
  return out;
}

function collectVarNames(node: FormulaNode, set = new Set<string>()): Set<string> {
  if (node.type === "var") set.add(node.name);
  else if (node.type === "not") collectVarNames(node.child, set);
  else {
    collectVarNames(node.left, set);
    collectVarNames(node.right, set);
  }
  return set;
}

export function tseitin(formula: FormulaNode): TseitinResult {
  validateFormula(formula);
  const ordered = postOrder(formula);
  const nodeIdOf = new Map<FormulaNode, number>();
  ordered.forEach((n, i) => nodeIdOf.set(n, i + 1));

  const varNames = [...collectVarNames(formula)].sort(); // 稳定排序
  const varIdOf = new Map(varNames.map((name, i) => [name, i + 1]));
  const auxStart = varNames.length + 1;

  const nodes: NodeInfo[] = [];
  const clauses: Clause[] = [];
  const litOf = new Map<FormulaNode, number>();
  let nextAux = auxStart;

  for (const n of ordered) {
    const id = nodeIdOf.get(n)!;
    if (n.type === "var") {
      const vid = varIdOf.get(n.name)!;
      litOf.set(n, vid);
      nodes.push({ nodeId: id, type: "var", detail: n.name, auxId: null, varId: vid });
      continue;
    }
    const z = nextAux++;
    litOf.set(n, z);
    nodes.push({ nodeId: id, type: n.type, detail: n.type, auxId: z, varId: null });
    const desc = (lits: string) => `z${z} <-> ${n.type}(${lits}) [节点 ${id}]`;
    if (n.type === "not") {
      const c = litOf.get(n.child)!;
      // z <-> !c : (z | c) & (!z | !c)
      clauses.push(
        { literals: [z, c], source: { nodeId: id, kind: "definition", description: desc(`z${c}`) } },
        { literals: [-z, -c], source: { nodeId: id, kind: "definition", description: desc(`z${c}`) } },
      );
    } else {
      const a = litOf.get(n.left)!;
      const b = litOf.get(n.right)!;
      if (n.type === "and") {
        // z <-> a&b : (!z|a) (!z|b) (z|!a|!b)
        clauses.push(
          { literals: [-z, a], source: { nodeId: id, kind: "definition", description: desc(`z${a}, z${b}`) } },
          { literals: [-z, b], source: { nodeId: id, kind: "definition", description: desc(`z${a}, z${b}`) } },
          { literals: [z, -a, -b], source: { nodeId: id, kind: "definition", description: desc(`z${a}, z${b}`) } },
        );
      } else {
        // z <-> a|b : (!z|a|b) (z|!a) (z|!b)
        clauses.push(
          { literals: [-z, a, b], source: { nodeId: id, kind: "definition", description: desc(`z${a}, z${b}`) } },
          { literals: [z, -a], source: { nodeId: id, kind: "definition", description: desc(`z${a}, z${b}`) } },
          { literals: [z, -b], source: { nodeId: id, kind: "definition", description: desc(`z${a}, z${b}`) } },
        );
      }
    }
  }

  const rootLit = litOf.get(formula)!;
  clauses.push({
    literals: [rootLit],
    source: { nodeId: nodeIdOf.get(formula)!, kind: "root", description: `根约束: z${rootLit} 为真` },
  });

  return {
    variables: varNames.map((name, i) => ({ name, id: i + 1 })),
    nodes,
    clauses,
    rootLiteral: rootLit,
    varCount: nextAux - 1,
    auxStart,
  };
}

// 直接对公式求值（独立实现，供扩展与测试使用）
export function evaluate(node: FormulaNode, env: Record<string, boolean>): boolean {
  switch (node.type) {
    case "var": {
      const v = env[node.name];
      if (typeof v !== "boolean") throw new FormulaError("E_MISSING_ASSIGNMENT", `变量 ${node.name} 缺少赋值或值非布尔`);
      return v;
    }
    case "not":
      return !evaluate(node.child, env);
    case "and":
      return evaluate(node.left, env) && evaluate(node.right, env);
    case "or":
      return evaluate(node.left, env) || evaluate(node.right, env);
  }
}

// 给定完整原变量赋值，计算唯一满足定义子句的辅助扩展（后序保证子节点先算）
export function extendAssignment(
  formula: FormulaNode,
  result: TseitinResult,
  env: Record<string, boolean>,
): Record<number, boolean> {
  for (const { name } of result.variables) {
    if (typeof env[name] !== "boolean")
      throw new FormulaError("E_MISSING_ASSIGNMENT", `变量 ${name} 缺少赋值或值非布尔`);
  }
  for (const k of Object.keys(env)) {
    if (!result.variables.some((v) => v.name === k))
      throw new FormulaError("E_UNKNOWN_VAR", `未知变量: ${k}`);
  }
  const ordered = postOrder(formula);
  const val = new Map<FormulaNode, boolean>();
  const full: Record<number, boolean> = {};
  for (const { name, id } of result.variables) full[id] = env[name];
  for (const n of ordered) {
    let v: boolean;
    if (n.type === "var") v = env[n.name];
    else if (n.type === "not") v = !val.get(n.child)!;
    else if (n.type === "and") v = val.get(n.left)! && val.get(n.right)!;
    else v = val.get(n.left)! || val.get(n.right)!;
    val.set(n, v);
  }
  // 通过后序节点顺序把值写入辅助 ID
  const auxByNode = new Map(result.nodes.filter((x) => x.auxId !== null).map((x) => [x.nodeId, x.auxId!]));
  ordered.forEach((n, i) => {
    const aux = auxByNode.get(i + 1);
    if (aux !== undefined) full[aux] = val.get(n)!;
  });
  return full;
}

export interface VerifyFailure {
  ok: false;
  clauseIndex: number; // 0 起
  clause: Clause;
  reason: string;
}

export function verifyAssignment(
  result: TseitinResult,
  assignment: Record<number, boolean>,
): { ok: true } | VerifyFailure {
  for (let id = 1; id <= result.varCount; id++) {
    const v = assignment[id];
    if (typeof v !== "boolean")
      throw new FormulaError("E_BAD_ASSIGNMENT", `变量 ID ${id} 缺少赋值或值非布尔`);
  }
  for (const k of Object.keys(assignment)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id < 1 || id > result.varCount)
      throw new FormulaError("E_BAD_ASSIGNMENT", `未知变量 ID: ${k}`);
  }
  for (let i = 0; i < result.clauses.length; i++) {
    const c = result.clauses[i];
    const sat = c.literals.some((lit) => assignment[Math.abs(lit)] === lit > 0);
    if (!sat) {
      return {
        ok: false,
        clauseIndex: i,
        clause: c,
        reason: `子句 #${i} (${c.source.kind}, 节点 ${c.source.nodeId}: ${c.source.description}) 不满足`,
      };
    }
  }
  return { ok: true };
}

export function toDimacs(result: TseitinResult): string {
  const lines: string[] = [];
  lines.push(`c Tseitin CNF, 原变量 ${result.variables.map((v) => `${v.id}=${v.name}`).join(" ")}`);
  lines.push(`c 辅助变量从 ${result.auxStart} 开始`);
  lines.push(`p cnf ${result.varCount} ${result.clauses.length}`);
  for (const c of result.clauses) lines.push(`${c.literals.join(" ")} 0`);
  return lines.join("\n") + "\n";
}
