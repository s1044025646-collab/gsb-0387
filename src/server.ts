// HTTP API 服务（node:http，无外部依赖）
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Store } from "./db.ts";
import {
  FormulaError,
  extendAssignment,
  toDimacs,
  tseitin,
  validateFormula,
  verifyAssignment,
} from "./tseitin.ts";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "tseitin.db");

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function err(res: http.ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new FormulaError("E_BAD_JSON", "请求体不是合法 JSON");
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

export async function createServer(
  port?: number,
): Promise<{ server: http.Server; port: number; store: Store }> {
  const store = new Store(DB_PATH);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "POST" && parts[0] === "formulas" && parts.length === 1) {
        const body = (await readBody(req)) as Record<string, unknown>;
        if (typeof body.name !== "string" || !body.name)
          return err(res, 400, "E_BAD_NAME", "缺少公式名称 name");
        validateFormula(body.formula);
        const rec = store.save(body.name, body.formula);
        return json(res, 201, { name: rec.name, version: rec.version, result: rec.result });
      }
      if (req.method === "GET" && parts[0] === "formulas" && parts.length === 1)
        return json(res, 200, { history: store.history() });
      if (req.method === "GET" && parts[0] === "formulas" && parts[2] === "history")
        return json(res, 200, { history: store.history(parts[1]) });

      const rec =
        parts[0] === "formulas" && parts.length >= 2
          ? store.get(
              parts[1],
              url.searchParams.get("version") ? Number(url.searchParams.get("version")) : undefined,
            )
          : null;
      if (parts[0] === "formulas" && !rec) return err(res, 404, "E_NOT_FOUND", "公式不存在");

      if (req.method === "GET" && parts.length === 2)
        return json(res, 200, {
          name: rec!.name,
          version: rec!.version,
          formula: rec!.formula,
          result: rec!.result,
        });
      if (req.method === "POST" && parts[2] === "extend") {
        const body = (await readBody(req)) as Record<string, unknown>;
        if (typeof body.assignment !== "object" || body.assignment === null)
          return err(res, 400, "E_BAD_ASSIGNMENT", "缺少 assignment 对象");
        const full = extendAssignment(rec!.formula, rec!.result, body.assignment as Record<string, boolean>);
        return json(res, 200, { assignment: full });
      }
      if (req.method === "POST" && parts[2] === "verify") {
        const body = (await readBody(req)) as Record<string, unknown>;
        if (typeof body.assignment !== "object" || body.assignment === null)
          return err(res, 400, "E_BAD_ASSIGNMENT", "缺少 assignment 对象");
        const out = verifyAssignment(rec!.result, body.assignment as Record<number, boolean>);
        return json(res, out.ok ? 200 : 422, out);
      }
      if (req.method === "GET" && parts[2] === "dimacs") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(toDimacs(rec!.result));
      }
      if (req.method === "POST" && parts[0] === "convert") {
        const body = (await readBody(req)) as Record<string, unknown>;
        validateFormula(body.formula);
        return json(res, 200, { result: tseitin(body.formula) });
      }
      return err(res, 404, "E_NOT_FOUND", "未知路由");
    } catch (e) {
      if (e instanceof FormulaError) return err(res, 400, e.code, e.message);
      throw e;
    }
  });

  const p = port ?? (Number(process.env.PORT ?? 0) || (await freePort()));
  await new Promise<void>((resolve) => server.listen(p, "127.0.0.1", resolve));
  const actual = (server.address() as net.AddressInfo).port;
  return { server, port: actual, store };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  const { port } = await createServer();
  console.log(`Tseitin API 已启动: http://127.0.0.1:${port}  (数据目录: ${DATA_DIR})`);
}
