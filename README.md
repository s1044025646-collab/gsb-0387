# Tseitin CNF 转换与辅助赋值核验后端

纯本地运行的后端服务：把由 **变量 / 非 / 二元与 / 二元或** 组成的命题公式（JSON 树）转换为线性规模的 Tseitin 合取范式（CNF），并支持原变量赋值的辅助扩展与完整赋值核验。只做 API 与 CLI，不含 SAT 求解器、最少子句优化或电路延迟仿真。

技术栈：TypeScript + Node.js（内置 `node:sqlite`，无原生编译依赖）+ Express。Windows 本地直接运行，不需要 Docker / WSL / 外部服务。

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试（含穷举验证）
npm run demo      # 运行演示：(a||b)&&!a、x&&!x、单变量公式
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
```

指定端口与数据库位置：

```powershell
node dist/src/server.js --port=8080
$env:PORT="8080"; $env:DB_PATH="E:\data\t.db"; node dist/src/server.js
```

数据目录默认为项目内 `data/`（数据库文件 `data/tseitin.db`），可用环境变量 `DB_PATH` 覆盖。

说明：Node 25 的 `node:sqlite` 会打印 ExperimentalWarning，不影响功能。

## 投影语义：等可满足，而非等价

转换结果为每个逻辑操作节点引入辅助变量 `z`，用子句约束 `z ↔ 子表达式真值`（双向约束），最后加入根文字为真的单位子句：

- `z ↔ a ∧ b`：`(-z ∨ a)`、`(-z ∨ b)`、`(z ∨ -a ∨ -b)`
- `z ↔ a ∨ b`：`(-z ∨ a ∨ b)`、`(z ∨ -a)`、`(z ∨ -b)`
- `z ↔ ¬c`：`(-z ∨ -c)`、`(z ∨ c)`

**完整 CNF 与原公式不是逻辑等价**：CNF 含有原公式不存在的辅助变量，不能说"在任意辅助赋值下都与原公式真值相等"。准确语义是**等可满足（equisatisfiable）+ 投影**：

1. 给定完整的原变量赋值，**恰好存在唯一**一组辅助变量取值满足全部定义子句（即按表达式自底向上求值的结果，由"扩展"接口计算）；
2. 在此唯一扩展下，加上根单位子句后 CNF 成立 **当且仅当** 原公式为真；
3. 把 CNF 的可满足赋值投影到原变量上，恰好是原公式的满足赋值。

核验接口**不会**替你修正辅助值：你给出的完整赋值中任何一个辅助位错了，都会报告第一个不满足的子句及其来源节点。

## JSON 公式语法

```json
{ "type": "var", "name": "a" }
{ "type": "not", "child": "<公式>" }
{ "type": "and", "left": "<公式>", "right": "<公式>" }
{ "type": "or",  "left": "<公式>", "right": "<公式>" }
```

- 变量名须匹配 `[A-Za-z_][A-Za-z0-9_]*`，且不能形如 `aux<数字>`（保留给辅助变量，避免碰撞）。
- 默认限制：节点数 ≤ 10000，嵌套深度 ≤ 500。
- 校验失败不会写入任何转换结果（不会产生半份 CNF）。

## 编号规则

- 原变量按名称字典序分配正整数 ID：`1..n`。
- 辅助变量 ID 从 `n+1` 开始，按**左右后序**（先左子树、再右子树、后当前节点）为每个操作节点依次分配；同一子式每次出现都独立引入辅助变量，不做公共子式去重。
- 文字用带符号整数表示（正为肯定、负为否定），0 不是文字（DIMACS 中仅作子句结尾）。
- 编号与来源关系持久化在 SQLite 中，重启后保持不变。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/formulas` | 导入公式并转换。Body: `{"name": "可选", "formula": {...}}`。同名公式创建新版本 |
| GET | `/history` | 查询全部转换历史 |
| GET | `/conversions/:id` | 读取变量表、节点到辅助 ID 映射、带来源子句、根约束、完整 CNF |
| POST | `/conversions/:id/extend` | 由原变量赋值扩展完整赋值。Body: `{"assignment": {"a": false}}` |
| POST | `/conversions/:id/verify` | 核验完整赋值（键为变量 ID）。Body: `{"assignment": {"1": false}}` |
| GET | `/conversions/:id/dimacs` | 导出 DIMACS（`p cnf` 头与内容一致） |

错误响应统一为 `{"error": {"code": "...", "message": "..."}}`，错误码：
`INVALID_NODE`、`INVALID_ARITY`、`INVALID_VAR_NAME`、`TOO_MANY_NODES`、`TOO_DEEP`、`MISSING_ASSIGNMENT`、`NON_BOOLEAN_ASSIGNMENT`、`NOT_FOUND`、`BAD_REQUEST`。

核验失败返回第一个不满足的子句及来源，例如：

```json
{ "ok": false, "clauseIndex": 2, "clause": [3, -2],
  "source": { "nodeId": 3, "kind": "def", "role": "z->a|b (right)" } }
```

## CLI

```powershell
node dist/src/cli.js import formula.json --name=demo   # 导入并转换（同名产生新版本）
node dist/src/cli.js show 1                            # 查看完整转换结果
node dist/src/cli.js extend 1 assign.json              # 扩展原变量赋值 {"a":false,"b":true}
node dist/src/cli.js verify 1 full.json                # 核验完整赋值 {"1":false,...,"5":true}
node dist/src/cli.js dimacs 1 out.cnf                  # 导出 DIMACS
node dist/src/cli.js history                           # 查询历史
```

`npm run cli -- <命令>` 等价（需先 `npm run build`）。

## 演示

`npm run demo` 展示：

1. `(a || b) && !a` 在 `a=false, b=true` 下扩展后核验通过；篡改 or 节点的辅助值后，定位到失败子句 `[3, -2]` 及其来源节点；
2. `x && !x` 的转换（定义子句可满足，但根约束使完整 CNF 不可满足）；
3. 单变量公式 `y`（直接生成单位子句 `1 0`）。

## 测试

`npm test` 覆盖：

- 对小公式**独立穷举**全部原变量与全部辅助变量赋值，用独立求值器核对：定义子句的唯一扩展性、根约束与原公式真值的对应关系（不是转换器自证）；
- 重复变量、重复子式（各自独立辅助变量）、深链、子句数随操作节点线性增长；
- `aux1` 命名冲突、非法节点/元数/变量名、缺失与非布尔赋值；
- SQLite 版本递增与模拟重启后的查询一致性、DIMACS 头与内容一致。

## 项目结构

- `src/tseitin.ts` 核心：校验、转换、扩展、核验、DIMACS
- `src/store.ts` SQLite 持久化（公式版本 + 转换结果）
- `src/server.ts` HTTP API（默认空闲端口）
- `src/cli.ts` 命令行
- `src/demo.ts` 演示脚本
- `test/` node:test 测试
- `data/` 运行时数据库目录

## 限制

- 只支持 var / not / and / or 四种节点，不含蕴含、等价等（可自行先改写）。
- 不做公共子式去重与最少子句优化；不做 SAT 求解。
- `node:sqlite` 在 Node 25 仍标记为实验特性，接口未来可能微调。
