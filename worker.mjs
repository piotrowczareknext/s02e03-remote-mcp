const authorizationCodes = new Map();
const clients = new Map();

const tools = [
  {
    name: "memo_write",
    description: "Save a note and return its stable id.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "memo_search",
    description: "Find saved notes whose text contains the query.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, text: { type: "string" }, createdAt: { type: "string" } },
            required: ["id", "text", "createdAt"],
          },
        },
      },
      required: ["notes"],
    },
  },
  {
    name: "upload",
    description: "Store a file and return a public link. Provide filename and either content, data (base64), or url.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", minLength: 1 },
        content: { type: "string" },
        data: { type: "string", description: "Base64-encoded file data." },
        url: { type: "string", format: "uri" },
        mimeType: { type: "string" },
      },
      required: ["filename"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { url: { type: "string", format: "uri" } }, required: ["url"] },
  },
  {
    name: "transcribe",
    description: "Fetch audio from a URL and return timestamped transcript segments.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        segments: {
          type: "array",
          items: {
            type: "object",
            properties: { start: { type: "number" }, text: { type: "string" } },
            required: ["start", "text"],
          },
        },
      },
      required: ["segments"],
    },
  },
];

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function origin(request) {
  return new URL(request.url).origin;
}

function textContent(value) {
  return [{ type: "text", text: JSON.stringify(value) }];
}

function result(id, value) {
  return { jsonrpc: "2.0", id, result: { content: textContent(value), structuredContent: value } };
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function base64(bytes) {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index]);
  return btoa(binary);
}

function bytesFromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function storageFetch(env, pathname, init) {
  if (!env.STORAGE) throw new Error("Persistent storage is not configured.");
  const id = env.STORAGE.idFromName("default");
  return env.STORAGE.get(id).fetch(`https://storage${pathname}`, init);
}

async function callTool(name, args, request, env) {
  if (name === "memo_write") {
    if (typeof args?.text !== "string" || !args.text) throw new Error("text is required");
    const id = crypto.randomUUID();
    const memo = { id, text: args.text, createdAt: new Date().toISOString() };
    const response = await storageFetch(env, "/memo/write", {
      method: "POST",
      body: JSON.stringify(memo),
    });
    if (!response.ok) throw new Error("Could not save memo.");
    return { id };
  }

  if (name === "memo_search") {
    const query = String(args?.query ?? "");
    const response = await storageFetch(env, `/memo/search?query=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error("Could not search memos.");
    return response.json();
  }

  if (name === "upload") {
    if (typeof args?.filename !== "string" || !args.filename) throw new Error("filename is required");
    let bytes;
    if (args.url) {
      const response = await fetch(args.url);
      if (!response.ok) throw new Error(`Could not download source: HTTP ${response.status}`);
      bytes = await response.arrayBuffer();
    } else if (args.data) {
      bytes = bytesFromBase64(args.data);
    } else if (typeof args.content === "string") {
      bytes = new TextEncoder().encode(args.content);
    } else {
      throw new Error("Provide content, base64 data, or a source url.");
    }
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const safeName = args.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${id}-${safeName}`;
    const response = await storageFetch(env, "/file", {
      method: "POST",
      body: JSON.stringify({
        key,
        data: base64(bytes),
        mimeType: args.mimeType || "application/octet-stream",
      }),
    });
    if (!response.ok) throw new Error("Could not store file.");
    return { url: `${origin(request)}/files/${encodeURIComponent(key)}` };
  }

  if (name === "transcribe") {
    if (typeof args?.url !== "string") throw new Error("url is required");
    const response = await fetch(args.url);
    if (!response.ok) throw new Error(`Could not fetch audio from ${args.url}: HTTP ${response.status}`);
    const type = response.headers.get("content-type") || "";
    const body = await response.arrayBuffer();
    if (!type.startsWith("audio/") && !/\.(mp3|wav|m4a|ogg|webm|flac)(?:\?|$)/i.test(args.url)) {
      throw new Error("The URL did not return audio content.");
    }
    if (!env.AI) throw new Error("Speech-to-text is not configured.");
    const transcription = await env.AI.run("@cf/openai/whisper", {
      audio: [...new Uint8Array(body)],
    });
    const segments = (transcription.segments || [])
      .map((segment) => ({
        start: Number(segment.start ?? segment.start_time ?? 0),
        text: String(segment.text ?? "").trim().replace(/\b([01]?\d|2[0-3])([0-5]\d)\b/g, "$1:$2"),
      }))
      .filter((segment) => segment.text);
    if (!segments.length && transcription.text) {
      segments.push({
        start: 0,
        text: String(transcription.text).trim().replace(/\b([01]?\d|2[0-3])([0-5]\d)\b/g, "$1:$2"),
      });
    }
    if (!segments.length) throw new Error("The audio produced no transcript.");
    return { segments };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcp(request, env) {
  const expectedToken = env.AUTH_TOKEN;
  if (!expectedToken || request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
    return json(
      { error: "unauthorized" },
      401,
      { "WWW-Authenticate": `Bearer resource_metadata="${origin(request)}/.well-known/oauth-protected-resource"` },
    );
  }

  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const body = await request.json();
  if (!body.id && body.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (body.method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "s02e03-remote-mcp", version: "1.0.0" },
      },
    });
  }
  if (body.method === "server/discover") {
    return json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28", "2025-06-18"],
        capabilities: { tools: {} },
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "s02e03-remote-mcp",
            version: "1.0.0",
          },
        },
        instructions: "This server provides memo, upload, and transcription tools.",
        ttlMs: 3600000,
        cacheScope: "public",
      },
    });
  }
  if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools } });
  if (body.method === "tools/call") {
    try {
      return json(result(body.id, await callTool(body.params?.name, body.params?.arguments || {}, request, env)));
    } catch (caught) {
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          isError: true,
          content: [{ type: "text", text: caught instanceof Error ? caught.message : String(caught) }],
        },
      });
    }
  }
  return json(error(body.id, -32601, `Method not found: ${body.method}`));
}

async function handleOAuth(request, env) {
  const url = new URL(request.url);
  const base = url.origin;

  if (url.pathname === "/oauth/register" && request.method === "POST") {
    const registration = await request.json().catch(() => ({}));
    const clientId = crypto.randomUUID();
    clients.set(clientId, registration);
    return json({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: "none" }, 201);
  }

  if (url.pathname === "/oauth/authorize") {
    const params = request.method === "GET" ? Object.fromEntries(url.searchParams) : Object.fromEntries(await request.formData());
    if (!params.redirect_uri) return json({ error: "redirect_uri is required" }, 400);
    if (request.method === "GET") {
      const fields = Object.entries(params)
        .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
        .join("\n");
      return new Response(`<!doctype html><meta charset="utf-8"><title>Authorize MCP access</title><h1>Authorize MCP access</h1><p>Allow the course to use this MCP server?</p><form method="post" action="/oauth/authorize">${fields}<button type="submit">Allow access</button></form>`, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const code = crypto.randomUUID();
    authorizationCodes.set(code, {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      challenge: params.code_challenge,
      expiresAt: Date.now() + 300000,
    });
    const redirect = new URL(params.redirect_uri);
    redirect.searchParams.set("code", code);
    if (params.state) redirect.searchParams.set("state", params.state);
    return Response.redirect(redirect.toString(), 302);
  }

  if (url.pathname === "/oauth/token" && request.method === "POST") {
    const params = Object.fromEntries(await request.formData());
    const authorization = authorizationCodes.get(params.code);
    if (!authorization || authorization.expiresAt < Date.now() || authorization.clientId !== params.client_id || authorization.redirectUri !== params.redirect_uri) {
      return json({ error: "invalid_grant" }, 400);
    }
    if (authorization.challenge) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(params.code_verifier || ""));
      const encoded = base64(digest).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      if (encoded !== authorization.challenge) return json({ error: "invalid_grant" }, 400);
    }
    authorizationCodes.delete(params.code);
    return json({ access_token: env.AUTH_TOKEN, token_type: "Bearer", expires_in: 3600, scope: "mcp" });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/docs") {
      return new Response("<!doctype html><title>S02E03 MCP server</title><h1>S02E03 remote MCP server</h1><p>Tools: memo_write, memo_search, upload, transcribe.</p>", { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json({
        resource: `${url.origin}/mcp`,
        resource_documentation: `${url.origin}/docs`,
        authorization_servers: [url.origin],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
      }, 200, { "content-type": "application/json" });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/oauth/authorize`,
        token_endpoint: `${url.origin}/oauth/token`,
        registration_endpoint: `${url.origin}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp"],
      }, 200, { "content-type": "application/json" });
    }
    if (url.pathname.startsWith("/oauth/")) return handleOAuth(request, env);
    if (url.pathname.startsWith("/files/") && request.method === "GET") {
      const key = encodeURIComponent(decodeURIComponent(url.pathname.slice("/files/".length)));
      return storageFetch(env, `/file/${key}`);
    }
    if (url.pathname === "/mcp") return handleMcp(request, env);
    return json({ error: "not found" }, 404);
  },
};

export class StorageDO {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/memo/write" && request.method === "POST") {
      const memo = await request.json();
      await this.storage.put(`memo:${memo.id}`, memo);
      return json({ ok: true });
    }

    if (url.pathname === "/memo/search" && request.method === "GET") {
      const query = (url.searchParams.get("query") || "").toLocaleLowerCase();
      const entries = await this.storage.list({ prefix: "memo:" });
      const notes = [...entries.values()].filter((memo) => memo.text.toLocaleLowerCase().includes(query));
      return json({ notes });
    }

    if (url.pathname === "/file" && request.method === "POST") {
      const file = await request.json();
      await this.storage.put(`file:${file.key}`, file);
      return json({ ok: true });
    }

    if (url.pathname.startsWith("/file/") && request.method === "GET") {
      const file = await this.storage.get(`file:${decodeURIComponent(url.pathname.slice("/file/".length))}`);
      if (!file) return json({ error: "not found" }, 404);
      return new Response(bytesFromBase64(file.data), { headers: { "content-type": file.mimeType } });
    }

    return json({ error: "not found" }, 404);
  }
}
