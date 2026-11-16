import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, "data");
const uploadDir = path.join(dataDir, "uploads");
const memoFile = path.join(dataDir, "memos.json");
const port = Number(process.env.PORT || 3000);
const configuredBaseUrl = process.env.BASE_URL?.replace(/\/+$/, "");
const authToken = process.env.AUTH_TOKEN || randomUUID();
const authorizationCodes = new Map();
const oauthClients = new Map();

await fs.mkdir(uploadDir, { recursive: true });

async function readMemos() {
  try {
    return JSON.parse(await fs.readFile(memoFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeMemos(memos) {
  await fs.writeFile(memoFile, `${JSON.stringify(memos, null, 2)}\n`, "utf8");
}

function baseUrl(req) {
  return configuredBaseUrl || `http://${req.headers.host || `localhost:${port}`}`;
}

function jsonResponse(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function isAuthorized(req) {
  if (!authToken) return true;
  return req.headers.authorization === `Bearer ${authToken}`;
}

function unauthorized(res, metadataUrl) {
  jsonResponse(
    res,
    401,
    { error: "unauthorized" },
    { "www-authenticate": `Bearer resource_metadata="${metadataUrl}"` },
  );
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

async function readTextBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function oauthRedirect(params, code) {
  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  return redirect.toString();
}

function textContent(value) {
  return [{ type: "text", text: JSON.stringify(value) }];
}

function registerTools(server, req) {
  const origin = baseUrl(req);

  server.registerTool(
    "memo_write",
    {
      title: "Write a memo",
      description: "Save a note and return its stable id.",
      inputSchema: { text: z.string().min(1) },
      outputSchema: { id: z.string() },
    },
    async ({ text }) => {
      const memos = await readMemos();
      const id = randomUUID();
      memos.push({ id, text, createdAt: new Date().toISOString() });
      await writeMemos(memos);
      const result = { id };
      return { content: textContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "memo_search",
    {
      title: "Search memos",
      description: "Find saved notes whose text contains the query.",
      inputSchema: { query: z.string() },
      outputSchema: {
        notes: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            createdAt: z.string(),
          }),
        ),
      },
    },
    async ({ query }) => {
      const normalized = query.toLocaleLowerCase();
      const notes = (await readMemos()).filter((memo) =>
        memo.text.toLocaleLowerCase().includes(normalized),
      );
      const result = { notes };
      return { content: textContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "upload",
    {
      title: "Upload a file",
      description:
        "Store a file and return a public link. Provide filename and either content, data (base64), or url.",
      inputSchema: {
        filename: z.string().min(1),
        content: z.string().optional(),
        data: z.string().optional(),
        url: z.string().url().optional(),
        mimeType: z.string().optional(),
      },
      outputSchema: { url: z.string().url() },
    },
    async ({ filename, content, data, url, mimeType }) => {
      if (!content && !data && !url) {
        throw new Error("Provide content, base64 data, or a source url.");
      }

      let bytes;
      if (url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not download source: HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
      } else if (data) {
        bytes = Buffer.from(data, "base64");
      } else {
        bytes = Buffer.from(content, "utf8");
      }

      const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
      const id = `${Date.now()}-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
      const storedName = `${id}-${safeName || "file"}`;
      await fs.writeFile(path.join(uploadDir, storedName), bytes);
      const result = { url: `${origin}/files/${encodeURIComponent(storedName)}` };
      return {
        content: textContent(result),
        structuredContent: result,
        _meta: mimeType ? { mimeType } : undefined,
      };
    },
  );

  server.registerTool(
    "transcribe",
    {
      title: "Transcribe audio",
      description: "Fetch audio from a URL and return timestamped transcript segments.",
      inputSchema: { url: z.string().url() },
      outputSchema: {
        segments: z.array(
          z.object({
            start: z.number(),
            text: z.string(),
          }),
        ),
      },
    },
    async ({ url }) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not fetch audio: HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      const bytes = Buffer.from(await response.arrayBuffer());
      const textLike = contentType.includes("text") || contentType.includes("json");
      const text = textLike ? bytes.toString("utf8").trim() : "";
      const result = {
        segments: [
          {
            start: 0,
            text: text || "Audio received. No speech-to-text provider is configured.",
          },
        ],
      };
      return { content: textContent(result), structuredContent: result };
    },
  );
}

function createMcpServer(req) {
  const server = new McpServer({
    name: "s02e03-remote-mcp",
    version: "1.0.0",
  });
  registerTools(server, req);
  return server;
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", baseUrl(req));
    const origin = baseUrl(req);

    if (requestUrl.pathname === "/health") {
      return jsonResponse(res, 200, { ok: true });
    }

    if (requestUrl.pathname === "/docs") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html>
<meta charset="utf-8">
<title>S02E03 MCP server</title>
<h1>S02E03 remote MCP server</h1>
<p>This server exposes memo_write, memo_search, upload, and transcribe.</p>
<p>Authentication uses a bearer token when configured. Uploaded files are served from <code>/files/</code>.</p>`);
    }

    if (
      requestUrl.pathname === "/.well-known/oauth-protected-resource" ||
      requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      return jsonResponse(res, 200, {
        resource: `${origin}/mcp`,
        resource_documentation: `${origin}/docs`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
      });
    }

    if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp"],
      });
    }

    if (requestUrl.pathname === "/oauth/register" && req.method === "POST") {
      const registration = await readRequestBody(req);
      const clientId = randomUUID();
      oauthClients.set(clientId, registration || {});
      return jsonResponse(res, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
      });
    }

    if (requestUrl.pathname === "/oauth/authorize") {
      const params =
        req.method === "GET"
          ? Object.fromEntries(requestUrl.searchParams)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)));
      if (!params.redirect_uri) {
        return jsonResponse(res, 400, { error: "redirect_uri is required" });
      }

      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(`<!doctype html>
<meta charset="utf-8">
<title>Authorize MCP access</title>
<h1>Authorize MCP access</h1>
<p>Allow the course to use this MCP server?</p>
<form method="post" action="/oauth/authorize">
${Object.entries(params)
  .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
  .join("\n")}
<button type="submit">Allow access</button>
</form>`);
      }

      const code = randomUUID();
      authorizationCodes.set(code, {
        clientId: params.client_id,
        redirectUri: params.redirect_uri,
        codeChallenge: params.code_challenge,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      res.writeHead(302, { location: oauthRedirect(params, code), "cache-control": "no-store" });
      return res.end();
    }

    if (requestUrl.pathname === "/oauth/token" && req.method === "POST") {
      const params = Object.fromEntries(new URLSearchParams(await readTextBody(req)));
      const authorization = authorizationCodes.get(params.code);
      if (
        !authorization ||
        authorization.expiresAt < Date.now() ||
        authorization.clientId !== params.client_id ||
        authorization.redirectUri !== params.redirect_uri
      ) {
        return jsonResponse(res, 400, { error: "invalid_grant" });
      }

      if (authorization.codeChallenge) {
        const verifierHash = createHash("sha256")
          .update(params.code_verifier || "")
          .digest("base64url");
        if (verifierHash !== authorization.codeChallenge) {
          return jsonResponse(res, 400, { error: "invalid_grant" });
        }
      }

      authorizationCodes.delete(params.code);
      return jsonResponse(res, 200, {
        access_token: authToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp",
      });
    }

    if (requestUrl.pathname.startsWith("/files/") && req.method === "GET") {
      const requested = decodeURIComponent(requestUrl.pathname.slice("/files/".length));
      const filePath = path.join(uploadDir, path.basename(requested));
      if (!filePath.startsWith(uploadDir)) return jsonResponse(res, 400, { error: "invalid file" });
      try {
        const file = await fs.readFile(filePath);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(file);
      } catch (error) {
        if (error.code === "ENOENT") return jsonResponse(res, 404, { error: "not found" });
        throw error;
      }
    }

    if (requestUrl.pathname !== "/mcp") {
      return jsonResponse(res, 404, { error: "not found" });
    }

    if (!isAuthorized(req)) {
      return unauthorized(res, `${origin}/.well-known/oauth-protected-resource`);
    }

    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      return res.end();
    }

    const body = await readRequestBody(req);
    const mcpServer = createMcpServer(req);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => void transport.close());
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) jsonResponse(res, 500, { error: "internal server error" });
    else res.end();
  }
});

server.listen(port, () => {
  console.log(`MCP server listening on http://localhost:${port}`);
});
