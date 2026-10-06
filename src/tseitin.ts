import { ApiError } from "./errors";

export type FormulaNode =
  | { type: "var"; name: string }
  | { type: "not"; child: FormulaNode }
  | { type: "and"; left: FormulaNode; right: FormulaNode }
  | { type: "or"; left: FormulaNode; right: FormulaNode };

export interface Limits {
  maxNodes: number;
  maxDepth: number;
}

export const DEFAULT_LIMITS: Limits = { maxNodes: 10000, maxDepth: 500 };

export interface ClauseSource {
  nodeId: number;
  kind: "def" | "root";
  role: string;
}

export interface SourcedClause {
  lits: number[];
  source: ClauseSource;
}

export interface NodeInfo {
  nodeId: number;
  type: string;
  auxId: number | null;
  describes: string;
}

export interface ConversionResult {
  variables: { name: string; id: number }[];
  nodes: NodeInfo[];
  clauses: SourcedClause[];
  rootLit: number;
  numVars: number;
  numClauses: number;
}

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_RE = /^aux[0-9]+$/i;

export function validateFormula(node: unknown, limits: Limits = DEFAULT_LIMITS): FormulaNode {
  let count = 0;
  function walk(n: unknown, depth: number): FormulaNode {
    if (depth > limits.maxDepth) {
      throw new ApiError("TOO_DEEP", `公式嵌套深度超过限制 ${limits.maxDepth}`);
    }
    count++;
    if (count > limits.maxNodes) {
      throw new ApiError("TOO_MANY_NODES", `公式节点数超过限制 ${limits.maxNodes}`);
    }
    if (typeof n !== "object" || n === null || Array.isArray(n)) {
      throw new ApiError("INVALID_NODE", "节点必须是对象");
    }
    const t = (n as Record<string, unknown>).type;
    if (t === "var") {
      const name = (n as Record<string, unknown>).name;
      if (typeof name !== "string" || !VAR_NAME_RE.test(name)) {
        throw new ApiError("INVALID_VAR_NAME", `非法变量名: ${JSON.stringify(name)}`);
      }
      if (RESERVED_RE.test(name)) {
        throw new ApiError("INVALID_VAR_NAME", `变量名 ${name} 与辅助变量命名保留冲突`);
      }
      return { type: "var", name };
    }
    if (t === "not") {
      const keys = Object.keys(n as object).filter((k) => k !== "type" && k !== "child");
      if (!("child" in (n as object)) || keys.length > 0) {
        throw new ApiError("INVALID_ARITY", "not 节点必须且只能有 child 字段");
      }
      return { type: "not", child: walk((n as { child: unknown }).child, depth + 1) };
    }
    if (t === "and" || t === "or") {
      const o = n as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => k !== "type" && k !== "left" && k !== "right");
      if (!("left" in o) || !("right" in o) || keys.length > 0) {
        throw new ApiError("INVALID_ARITY", `${t} 节点必须且只能有 left 和 right 字段`);
      }
      return { type: t, left: walk(o.left, depth + 1), right: walk(o.right, depth + 1) };
    }
    throw new ApiError("INVALID_NODE", `未知节点类型: ${JSON.stringify(t)}`);
  }
  return walk(node, 1);
}

interface InternalNodeInfo {
  nodeId: number;
  type: string;
  auxId: number | null;
  name?: string;
}

export function convert(formula: FormulaNode): ConversionResult {
  const varNames = new Set<string>();
  (function collect(n: FormulaNode) {
    if (n.type === "var") varNames.add(n.name);
    else if (n.type === "not") collect(n.child);
    else {
      collect(n.left);
      collect(n.right);
    }
  })(formula);
  const sorted = [...varNames].sort();
  const varId = new Map<string, number>();
  sorted.forEach((name, i) => varId.set(name, i + 1));

  let nextAux = sorted.length + 1;
  let nextNodeId = 1;
  const clauses: SourcedClause[] = [];
  const nodes: InternalNodeInfo[] = [];

  // 左右后序遍历：先左、再右、后根；操作节点在此引入辅助变量
  function walk(n: FormulaNode): number {
    if (n.type === "var") {
      nodes.push({ nodeId: nextNodeId++, type: "var", auxId: null, name: n.name });
      return varId.get(n.name)!;
    }
    let childLits: number[];
    if (n.type === "not") {
      childLits = [walk(n.child)];
    } else {
      const l = walk(n.left);
      const r = walk(n.right);
      childLits = [l, r];
    }
    const nodeId = nextNodeId++;
    const z = nextAux++;
    nodes.push({ nodeId, type: n.type, auxId: z });
    const src = (role: string): ClauseSource => ({ nodeId, kind: "def", role });
    if (n.type === "not") {
      const c = childLits[0];
      // z <-> !c
      clauses.push({ lits: [-z, -c], source: src("z->!c") });
      clauses.push({ lits: [z, c], source: src("!c->z") });
    } else if (n.type === "and") {
      const [a, b] = childLits;
      // z <-> a & b
      clauses.push({ lits: [-z, a], source: src("z->a") });
      clauses.push({ lits: [-z, b], source: src("z->b") });
      clauses.push({ lits: [z, -a, -b], source: src("a&b->z") });
    } else {
      const [a, b] = childLits;
      // z <-> a | b
      clauses.push({ lits: [-z, a, b], source: src("a|b->z") });
      clauses.push({ lits: [z, -a], source: src("z->a|b (left)") });
      clauses.push({ lits: [z, -b], source: src("z->a|b (right)") });
    }
    return z;
  }

  const rootLit = walk(formula);
  clauses.push({ lits: [rootLit], source: { nodeId: rootLit > sorted.length ? nodes[nodes.length - 1].nodeId : nodes[0].nodeId, kind: "root", role: "root-is-true" } });

  const describe = (info: InternalNodeInfo): string => {
    if (info.type === "var") return `变量 ${info.name}`;
    return `aux${info.auxId} 代表节点#${info.nodeId} (${info.type}) 子表达式的真值`;
  };

  return {
    variables: sorted.map((name) => ({ name, id: varId.get(name)! })),
    nodes: nodes.map((n) => ({ nodeId: n.nodeId, type: n.type, auxId: n.auxId, describes: describe(n) })),
    clauses,
    rootLit,
    numVars: nextAux - 1,
    numClauses: clauses.length,
  };
}

export function checkVarAssignment(
  result: ConversionResult,
  assignment: Record<string, unknown>
): Map<number, boolean> {
  const map = new Map<number, boolean>();
  for (const v of result.variables) {
    if (!(v.name in assignment)) {
      throw new ApiError("MISSING_ASSIGNMENT", `缺少变量 ${v.name} 的赋值`);
    }
    const val = assignment[v.name];
    if (typeof val !== "boolean") {
      throw new ApiError("NON_BOOLEAN_ASSIGNMENT", `变量 ${v.name} 的赋值不是布尔值`);
    }
    map.set(v.id, val);
  }
  return map;
}

// 按表达式求值，得到唯一满足定义子句的辅助扩展
export function extendAssignment(
  formula: FormulaNode,
  result: ConversionResult,
  varAssignment: Map<number, boolean>
): Map<number, boolean> {
  const full = new Map<number, boolean>(varAssignment);
  const idOf = new Map<string, number>();
  for (const v of result.variables) idOf.set(v.name, v.id);

  // 用与 convert 相同的后序顺序为操作节点赋辅助值
  const auxQueue: number[] = result.nodes.filter((n) => n.auxId !== null).map((n) => n.auxId!);
  let idx = 0;
  function walkAssign(n: FormulaNode): boolean {
    if (n.type === "var") return varAssignment.get(idOf.get(n.name)!)!;
    let val: boolean;
    if (n.type === "not") val = !walkAssign(n.child);
    else {
      const l = walkAssign(n.left);
      const r = walkAssign(n.right);
      val = n.type === "and" ? l && r : l || r;
    }
    full.set(auxQueue[idx++], val);
    return val;
  }
  walkAssign(formula);
  return full;
}

export interface VerifyFailure {
  ok: false;
  clauseIndex: number;
  clause: number[];
  source: ClauseSource;
}

export function verifyFullAssignment(
  result: ConversionResult,
  full: Map<number, boolean>
): { ok: true } | VerifyFailure {
  for (let i = 1; i <= result.numVars; i++) {
    if (!full.has(i)) {
      throw new ApiError("MISSING_ASSIGNMENT", `缺少变量 ID ${i} 的赋值（含辅助变量）`);
    }
  }
  for (let i = 0; i < result.clauses.length; i++) {
    const c = result.clauses[i];
    const sat = c.lits.some((lit) => full.get(Math.abs(lit)) === lit > 0);
    if (!sat) {
      return { ok: false, clauseIndex: i, clause: c.lits, source: c.source };
    }
  }
  return { ok: true };
}

export function toDimacs(result: ConversionResult): string {
  const lines: string[] = [];
  lines.push(`c Tseitin CNF, root literal: ${result.rootLit}`);
  for (const v of result.variables) lines.push(`c var ${v.id} = ${v.name}`);
  for (const n of result.nodes) {
    if (n.auxId !== null) lines.push(`c aux${n.auxId} <-> node#${n.nodeId} (${n.type})`);
  }
  lines.push(`p cnf ${result.numVars} ${result.numClauses}`);
  for (const c of result.clauses) lines.push(`${c.lits.join(" ")} 0`);
  return lines.join("\n") + "\n";
}
