const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

type HeaderMap = Record<string, string>;

interface Config {
  upstreamUrl: URL;
  listenHost: string;
  listenPort: number;
  upstreamHeaders: HeaderMap;
  handshakeHeaders: HeaderMap;
  corsOrigin: string;
  corsAllowCredentials: boolean;
}

function parseJsonHeaders(value: string | undefined, name: string): HeaderMap {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }

    const result: HeaderMap = {};
    for (const [key, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof rawValue !== "string") {
        throw new Error(`header ${key} must be a string`);
      }
      result[key] = rawValue;
    }
    return result;
  } catch (error) {
    throw new Error(`Invalid ${name}: ${(error as Error).message}`);
  }
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value == null || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function parseBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function buildConfig(): Config {
  const upstreamUrl = new URL(env("UPSTREAM_URL"));
  const listenPort = Number.parseInt(optionalEnv("PORT", "8787"), 10);

  if (!Number.isFinite(listenPort) || listenPort <= 0) {
    throw new Error(`Invalid PORT: ${optionalEnv("PORT", "8787")}`);
  }

  return {
    upstreamUrl,
    listenHost: optionalEnv("HOST", "0.0.0.0"),
    listenPort,
    upstreamHeaders: parseJsonHeaders(process.env.UPSTREAM_HEADERS_JSON, "UPSTREAM_HEADERS_JSON"),
    handshakeHeaders: parseJsonHeaders(process.env.UPSTREAM_HANDSHAKE_HEADERS_JSON, "UPSTREAM_HANDSHAKE_HEADERS_JSON"),
    corsOrigin: optionalEnv("CORS_ORIGIN", "*"),
    corsAllowCredentials: parseBool(process.env.CORS_ALLOW_CREDENTIALS, false),
  };
}

function isHandshakeRequest(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  const contentType = request.headers.get("content-type") ?? "";
  const url = new URL(request.url);

  return (
    request.method === "GET" &&
    (accept.includes("text/event-stream") || accept.includes("text/plain")) &&
    (url.pathname.includes("sse") || url.searchParams.get("transport") === "sse" || url.searchParams.get("mode") === "sse" || contentType.includes("text/event-stream"))
  );
}

function copyRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  return headers;
}

function mergeHeaders(base: Headers, overlay: HeaderMap): Headers {
  for (const [key, value] of Object.entries(overlay)) {
    base.set(key, value);
  }
  return base;
}

function buildUpstreamUrl(request: Request, upstreamBase: URL): URL {
  const incoming = new URL(request.url);
  const target = new URL(upstreamBase.toString());
  const basePath = target.pathname || "/";
  const incomingPath = incoming.pathname || "/";

  if (basePath === "/") {
    target.pathname = incomingPath;
  } else if (incomingPath === basePath) {
    target.pathname = basePath;
  } else if (incomingPath.startsWith(`${basePath}/`)) {
    target.pathname = incomingPath;
  } else if (incomingPath === "/") {
    target.pathname = basePath;
  } else {
    target.pathname = `${basePath.replace(/\/$/, "")}${incomingPath}`;
  }

  target.search = incoming.search;
  target.hash = "";
  return target;
}

function corsHeaders(config: Config): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", config.corsOrigin);
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization,Content-Type,Accept,Origin,Referer,User-Agent,X-Requested-With,X-Session-Id,X-MCP-Session-Id"
  );
  headers.set("Access-Control-Expose-Headers", "Content-Type,Location,Cache-Control,Connection,Transfer-Encoding");
  headers.set("Vary", "Origin");
  if (config.corsAllowCredentials) {
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return headers;
}

async function proxyRequest(request: Request, config: Config): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(request, config.upstreamUrl);
  const headers = copyRequestHeaders(request);
  mergeHeaders(headers, config.upstreamHeaders);

  if (isHandshakeRequest(request)) {
    mergeHeaders(headers, config.handshakeHeaders);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex?: "half" }).duplex = "half";
  }

  const upstreamResponse = await fetch(upstreamUrl, init);
  const responseHeaders = new Headers(upstreamResponse.headers);
  for (const [key, value] of corsHeaders(config)) {
    responseHeaders.set(key, value);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

const config = buildConfig();

console.log(
  `MCP SSE proxy listening on http://${config.listenHost}:${config.listenPort}, forwarding to ${config.upstreamUrl.toString()}`
);

Bun.serve({
  hostname: config.listenHost,
  port: config.listenPort,
  fetch: async (request) => {
    const cors = corsHeaders(config);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      return await proxyRequest(request, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown proxy error";
      return new Response(JSON.stringify({ error: message }), {
        status: 502,
        headers: {
          "content-type": "application/json",
          ...Object.fromEntries(cors.entries()),
        },
      });
    }
  },
});
