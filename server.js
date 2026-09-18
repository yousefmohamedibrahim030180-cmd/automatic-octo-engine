const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const SECRET = String(process.env.ORBIT_PERSIST_SECRET || "");
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "orbit-state.json");
const MAX_BODY = 64 * 1024 * 1024;

let state = null;
let updatedAt = null;
let writeChain = Promise.resolve();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state = parsed?.data ?? null;
    updatedAt = parsed?.updatedAt || null;
  }
} catch (error) {
  console.error("[orbit-sidecar] failed to restore state:", error.message);
}

function authorized(req) {
  return Boolean(SECRET) && req.headers["x-orbit-secret"] === SECRET;
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        service: "orbit-persistence-sidecar",
        hasState: state !== null,
        updatedAt
      });
    }

    if (req.url !== "/state") return send(res, 404, { error: "Not found" });
    if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });

    if (req.method === "GET") {
      if (state === null) return send(res, 404, { error: "No state yet" });
      return send(res, 200, { data: state, updatedAt });
    }

    if (req.method === "PUT") {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      if (!payload || typeof payload.data !== "object" || payload.data === null) {
        return send(res, 400, { error: "Invalid state payload" });
      }

      const nextState = payload.data;
      const nextUpdatedAt = new Date().toISOString();
      const diskPayload = JSON.stringify({ data: nextState, updatedAt: nextUpdatedAt });

      writeChain = writeChain.then(async () => {
        const tempFile = STATE_FILE + ".tmp";
        await fs.promises.writeFile(tempFile, diskPayload, "utf8");
        await fs.promises.rename(tempFile, STATE_FILE);
        state = nextState;
        updatedAt = nextUpdatedAt;
      });
      await writeChain;

      return send(res, 200, { ok: true, updatedAt });
    }

    return send(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error("[orbit-sidecar] request failed:", error);
    return send(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[orbit-sidecar] listening on " + PORT + (SECRET ? " with secret protection" : " without secret protection"));
});
