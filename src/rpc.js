// Stateless MCP over Streamable HTTP: each POST gets one JSON response, no sessions, no streaming.
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function serveMcp(request, { serverInfo, instructions, tools, call }) {
  let message;
  try {
    message = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  const methods = {
    initialize: ({ protocolVersion }) => ({
      protocolVersion: PROTOCOL_VERSIONS.includes(protocolVersion) ? protocolVersion : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo,
      instructions,
    }),
    ping: () => ({}),
    "tools/list": () => ({ tools }),
    "tools/call": ({ name, arguments: args }) => {
      if (!tools.some((t) => t.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
      return call(name, args ?? {});
    },
  };
  const handle = async (msg) => {
    const isNotification = msg?.id === undefined;
    if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return isNotification ? null : rpcError(msg.id, -32600, "Invalid request");
    }
    if (isNotification) return null;
    const method = methods[msg.method];
    if (!method) return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    try {
      return { jsonrpc: "2.0", id: msg.id, result: await method(msg.params ?? {}) };
    } catch (err) {
      if (err instanceof RpcError) return rpcError(msg.id, err.code, err.message);
      throw err;
    }
  };
  if (Array.isArray(message)) return json(rpcError(null, -32600, "Batch requests aren't supported"), 400);
  const reply = await handle(message);
  return reply ? json(reply) : new Response(null, { status: 202 });
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

export function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
