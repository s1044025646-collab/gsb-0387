# Tseitin CNF 转换与辅助赋值核验后端

纯本地 Windows 后端：TypeScript + Node.js（>= 22，推荐 25）+ SQLite（`node:sqlite` 内置模块），零外部运行时依赖，不需要 Docker / WSL / 在线服务。只做 API 与 CLI，不含 SAT 求解器、不做最少子句优化。

## 快速开始

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # tsc 类型检查并编译到 dist/
npm test           # 运行全部测试（含独立暴力枚举交叉验证）
npm run demo       # 演示：(a|b)&!a 扩展与篡改定位、x&!x、单变量公式
npm start          # 启动 API（默认自动选择空闲端口；PORT=8080 可指定）
npm run cli -- history
```

数据保存在项目内 `data/tseitin.db`（可用环境变量 `DATA_DIR` 覆盖）。

## 投影语义（等价 vs 等可满足）

对每个操作节点引入辅助变量 z，并用少量子句双向约束 `z <-> 子表达式`：

- `z <-> a AND b`：`(-z a)`、`(-z b)`、`(z -a -b)`
- `z <-> a OR b`：`(-z a b)`、`(z -a)`、`(z -b)`
- `z <-> NOT c`：`(z c)`、`(-z -c)`

最后加入根变量为真的单位子句。注意：

- 完整 CNF 与原公式**不是逻辑等价**，只是**等可满足（equisatisfiable）**：CNF 在原变量上的投影恰好等于原公式的满足赋值集，辅助变量的取值不能任意。
- 给定完整的原变量赋值，定义子句存在**唯一**的辅助扩展（按后序逐节点求值即得，`extend` 命令）；加上根约束后，CNF 成立当且仅当原公式为真。
- 核验用户给出的完整赋值时，报告第一个不满足的子句及其来源节点，绝不替用户"改正"辅助值。

编号规则：原变量按名称稳定排序分配 1..n；辅助变量从 n+1 起，按固定左右后序编号，每个子表达式出现独立引入（不做公共子式去重）。辅助 ID 区间与原变量分离，用户变量即使叫 `aux1` 也不会碰撞。文字为带符号整数，0 非法。

## JSON 公式语法

```json
{ "type": "var", "name": "a" }
{ "type": "not", "child": "<公式>" }
{ "type": "and", "left": "<公式>", "right": "<公式>" }
{ "type": "or",  "left": "<公式>", "right": "<公式>" }
```

变量名须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`。限制：节点数不超过 10000，嵌套深度不超过 500；任何校验失败都不会产生半份 CNF。

## CLI

```powershell
npm run cli -- import <name> <formula.json|JSON串>   # 导入；同名自动创建新版本
npm run cli -- convert <formula.json|JSON串>         # 一次性转换（不落库）
npm run cli -- show <name> [version]                 # 读取节点与子句（含来源）
npm run cli -- extend <name> <assign.json>           # 扩展原赋值，如 {"a":false,"b":true}
npm run cli -- verify <name> <assign.json>           # 核验完整赋值，如 {"1":false,"2":true}
npm run cli -- dimacs <name>                         # 导出 DIMACS（p cnf 行与内容一致）
npm run cli -- history [name]                        # 查询历史版本
```

## HTTP API

默认绑定 `127.0.0.1`，未指定 `PORT` 时自动选择空闲端口并打印。

- `POST /formulas` `{name, formula}` → 201 `{name, version, result}`（导入并转换，同名升版本）
- `POST /convert` `{formula}` → 一次性转换，不落库
- `GET /formulas` / `GET /formulas/:name/history` → 历史
- `GET /formulas/:name?version=N` → 公式、变量表、节点到辅助映射、带来源子句、根约束
- `POST /formulas/:name/extend` `{assignment: {变量名: bool}}` → 唯一辅助扩展（键为变量 ID 的完整赋值）
- `POST /formulas/:name/verify` `{assignment: {变量ID: bool}}` → 200 `{ok:true}` 或 422 首个不满足子句及来源
- `GET /formulas/:name/dimacs` → DIMACS 文本

## 错误码

`E_BAD_JSON` 请求体非法 · `E_BAD_NODE`/`E_BAD_TYPE` 节点结构或类型非法 · `E_ARITY` 操作元个数错误 · `E_BAD_VAR_NAME` 变量名非法 · `E_TOO_MANY_NODES`/`E_TOO_DEEP` 超上限 · `E_MISSING_ASSIGNMENT`/`E_UNKNOWN_VAR`/`E_BAD_ASSIGNMENT` 赋值缺失、未知变量或非布尔 · `E_NOT_FOUND` 公式不存在 · `E_USAGE` CLI 参数错误

## 测试

`npm test` 覆盖：对小公式**独立暴力枚举**全部原变量与辅助赋值（不调用转换器的求值器），验证等可满足性与辅助扩展唯一性；重复变量、重复子式、深链、`aux1` 名字冲突、非法节点、缺失/非布尔赋值、篡改辅助值定位、子句数随操作节点线性增长、SQLite 版本管理与重启后查询、DIMACS 头一致性。

## 限制

- 不含通用 SAT 求解；`verify` 只核验给定完整赋值。
- 每次子表达式出现独立引入辅助变量，不做公共子式去重或子句数优化。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，属正常现象。
