import express, { Request, Response, NextFunction } from "express";
import { Store, defaultDbPath } from "./store";
import {
  validateFormula,
  convert,
  checkVarAssignment,
  extendAssignment,
  verifyFullAssignment,
  toDimacs,
  DEFAULT_LIMITS,
} from "./tseitin";
import { ApiError } from "./errors";

export function createApp(store: Store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const wrap = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (e) {
      next(e);
    }
  };

  // 导入公式并转换（同名公式产生新版本）
  app.post(
    "/formulas",
    wrap((req, res) => {
      const body = req.body ?? {};
      if (typeof body.formula === "undefined") {
        throw new ApiError("BAD_REQUEST", "请求体必须包含 formula 字段");
      }
      const name = typeof body.name === "string" && body.name.length > 0 ? body.name : `formula-${Date.now()}`;
      const formula = validateFormula(body.formula, DEFAULT_LIMITS);
      const result = convert(formula);
      const saved = store.saveConversion(name, formula, result);
      res.status(201).json({ id: saved.id, name: saved.formulaName, version: saved.version, result });
    })
  );

  // 查询历史
  app.get(
    "/history",
    wrap((_req, res) => {
      res.json(store.history());
    })
  );

  // 读取转换结果（变量表、节点映射、带来源子句、根约束、完整 CNF）
  app.get(
    "/conversions/:id",
    wrap((req, res) => {
      const c = store.getConversion(Number(req.params.id));
      res.json(c);
    })
  );

  // 扩展原变量赋值为完整赋值
  app.post(
    "/conversions/:id/extend",
    wrap((req, res) => {
      const c = store.getConversion(Number(req.params.id));
      const assignment = (req.body ?? {}).assignment;
      if (typeof assignment !== "object" || assignment === null) {
        throw new ApiError("BAD_REQUEST", "请求体必须包含 assignment 对象");
      }
      const varAssign = checkVarAssignment(c.result, assignment);
      const full = extendAssignment(c.formula, c.result, varAssign);
      const byName: Record<string, boolean> = {};
      for (const v of c.result.variables) byName[v.name] = varAssign.get(v.id)!;
      const aux: Record<string, boolean> = {};
      for (const n of c.result.nodes) {
        if (n.auxId !== null) aux[`aux${n.auxId}`] = full.get(n.auxId)!;
      }
      res.json({ variables: byName, aux, full: Object.fromEntries(full) });
    })
  );

  // 核验完整赋值（原变量 + 辅助变量，按 ID 提供）
  app.post(
    "/conversions/:id/verify",
    wrap((req, res) => {
      const c = store.getConversion(Number(req.params.id));
      const assignment = (req.body ?? {}).assignment;
      if (typeof assignment !== "object" || assignment === null) {
        throw new ApiError("BAD_REQUEST", "请求体必须包含 assignment 对象（键为变量 ID）");
      }
      const full = new Map<number, boolean>();
      for (const [k, v] of Object.entries(assignment)) {
        if (typeof v !== "boolean") {
          throw new ApiError("NON_BOOLEAN_ASSIGNMENT", `变量 ${k} 的赋值不是布尔值`);
        }
        const id = Number(k);
        if (!Number.isInteger(id) || id < 1) {
          throw new ApiError("BAD_REQUEST", `非法变量 ID: ${k}`);
        }
        full.set(id, v);
      }
      res.json(verifyFullAssignment(c.result, full));
    })
  );

  // 导出 DIMACS
  app.get(
    "/conversions/:id/dimacs",
    wrap((req, res) => {
      const c = store.getConversion(Number(req.params.id));
      res.type("text/plain").send(toDimacs(c.result));
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
    } else {
      res.status(500).json({ error: { code: "INTERNAL", message: String(err) } });
    }
  });

  return app;
}

export function startServer(port: number, dbPath: string): Promise<number> {
  const store = new Store(dbPath);
  const app = createApp(store);
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`Tseitin CNF 服务已启动: http://127.0.0.1:${actual} (数据库: ${dbPath})`);
      resolve(actual);
    });
  });
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=")[1]) : Number(process.env.PORT ?? 0);
  startServer(port, process.env.DB_PATH ?? defaultDbPath());
}
