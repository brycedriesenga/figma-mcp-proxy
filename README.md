# MCP SSE Proxy

A small Bun/TypeScript reverse proxy for MCP-style SSE servers.

It forwards incoming requests to an upstream MCP/SSE server, while letting you inject configurable headers during the initial handshake. This is useful for upstreams that expect special auth or client headers only when the SSE transport is first established.

## What it does

- Proxies all HTTP methods to an upstream base URL
- Streams SSE responses without buffering them
- Lets you set static upstream headers for every request
- Lets you set additional headers only for the initial SSE handshake
- Adds permissive CORS headers for browser-based clients

## Files

- `package.json` – Bun scripts
- `index.ts` – proxy server implementation
- `README.md` – setup instructions

## Requirements

- Bun 1.x

## Setup

1. Install dependencies. There are no runtime dependencies, so this is mainly for Bun to create the lockfile if you want one:

```bash
bun install
```

2. Set environment variables:

```bash
export UPSTREAM_URL="https://example.com/sse"
export PORT=8787
export HOST=0.0.0.0
```

Optional header configuration:

```bash
export UPSTREAM_HEADERS_JSON='{"Authorization":"Bearer YOUR_TOKEN"}'
export UPSTREAM_HANDSHAKE_HEADERS_JSON='{"X-Figma-Client":"mcp-proxy","X-Client-Name":"my-app"}'
```

Optional CORS settings:

```bash
export CORS_ORIGIN='*'
export CORS_ALLOW_CREDENTIALS=false
```

3. Start the proxy:

```bash
bun run start
```

Or for development:

```bash
bun run dev
```

## Configuration

### Required

- `UPSTREAM_URL` – Base URL of the upstream MCP/SSE server

### Optional

- `HOST` – Host to bind to, default `0.0.0.0`
- `PORT` – Port to bind to, default `8787`
- `UPSTREAM_HEADERS_JSON` – JSON object of headers applied to every proxied request
- `UPSTREAM_HANDSHAKE_HEADERS_JSON` – JSON object of headers applied only to the initial SSE handshake request
- `CORS_ORIGIN` – Value for `Access-Control-Allow-Origin`, default `*`
- `CORS_ALLOW_CREDENTIALS` – Set to `true` to enable credentials

## Handshake behavior

The proxy treats a request as the initial SSE handshake when all of the following are true:

- method is `GET`
- the request appears to be SSE-related (`Accept: text/event-stream`, or the path/query indicates SSE)

For that request, the proxy merges in `UPSTREAM_HANDSHAKE_HEADERS_JSON` before sending the request upstream.

This is intended for upstreams that need extra headers only when the SSE transport is first created.

## Example

```bash
UPSTREAM_URL="https://mcp.example.com/sse" \
UPSTREAM_HEADERS_JSON='{"Authorization":"Bearer secret"}' \
UPSTREAM_HANDSHAKE_HEADERS_JSON='{"X-MCP-Client":"proxy"}' \
PORT=8787 \
bun run start
```

Then point your MCP client at:

```text
http://localhost:8787/sse
```

## Notes

- The proxy forwards request bodies for non-GET/HEAD requests.
- It preserves upstream status codes and response headers.
- It does not buffer SSE bodies, so event streams remain live.
EOF