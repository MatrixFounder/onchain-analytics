#!/usr/bin/env sh
# One authenticated MCP round trip against a running network profile (T-015 task 015-25, AC-44).
#
# Prints statuses and counts only. The token never reaches the screen, the log or a command line —
# it is read with echo off and handed to node through the environment.
#
#   ./scripts/probe-token-request.sh                 # http://127.0.0.1:8848/mcp
#   MCP_URL=http://127.0.0.1:9000/mcp ./scripts/probe-token-request.sh
#
# WHY A HANDSHAKE AND NOT A BARE `tools/list`. Streamable HTTP answers 400 to a request that carries
# no `Mcp-Session-Id` and is not an `initialize` — "a request with no session and no initialize has
# nothing to attach to" (src/transport/http.ts). A single `tools/list` therefore proves only that the
# transport is awake. The three calls below are the smallest sequence that reaches a tool handler,
# which is what AC-44 is actually about.
#
# WHY 400 AND 401 MUST NOT BE READ AS THE SAME THING. 401 is the authentication refusal; 400 comes
# from the layer AFTER it. Getting 400 means the token was accepted.
#
# WHY A FILE AND NOT A BLOCK TO PASTE. A pasted block containing an interactive `read` feeds itself:
# `read` takes the next line of the block as the value. From a file, `read` takes the terminal.
set -eu

MCP_URL="${MCP_URL:-http://127.0.0.1:8848/mcp}"

printf 'token: '
stty -echo 2>/dev/null || true
read -r TOKEN
stty echo 2>/dev/null || true
printf '\n'

TOKEN="$TOKEN" MCP_URL="$MCP_URL" node -e '
const token = process.env.TOKEN ?? "";
const url = process.env.MCP_URL;
if (!token) { console.log("REFUSED: nothing was read into the token variable"); process.exit(1); }

const ACCEPT = "application/json, text/event-stream";
const call = async (body, sessionId) => {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: ACCEPT,
    "mcp-protocol-version": "2025-06-18",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), text };
};

// An SSE body arrives as `event: message\ndata: {...}`; a JSON body is the object itself.
const payload = (text) => {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  try { return JSON.parse(line ? line.slice(5).trim() : text); } catch { return null; }
};

(async () => {
  const init = await call({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t015-ac44-probe", version: "1.0.0" },
    },
  });
  console.log("initialize                  :", init.status);
  if (init.status === 401) { console.log("=> AUTHENTICATION REFUSED — this is the failing case"); process.exit(1); }
  if (init.status !== 200) { console.log("=> unexpected; body starts:", init.text.slice(0, 160)); process.exit(1); }
  const sid = init.sessionId;
  console.log("session established         :", Boolean(sid));
  if (!sid) { console.log("REFUSED: no Mcp-Session-Id came back"); process.exit(1); }

  await call({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);

  const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
  console.log("tools/list                  :", list.status);
  const tools = payload(list.text)?.result?.tools;
  console.log("tools returned              :", Array.isArray(tools) ? tools.length : "(none)");

  // `tools/list` is a PROTOCOL method, not a tool invocation: it reaches no handler and therefore
  // writes no `request_trace` row (that table records a tool call — tool, capability, served_from,
  // vendor spend). AC-44 asks whether the token reaches a HANDLER, so the probe calls one.
  // `onchain_ping` takes no parameters, contacts no vendor and spends no credits.
  const ping = await call({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "onchain_ping", arguments: {} },
  }, sid);
  console.log("tools/call onchain_ping     :", ping.status);
  const result = payload(ping.text)?.result;
  const ok = result !== undefined && result?.isError !== true;
  console.log("handler answered            :", ok);
  console.log(ok
    ? "=> AC-44 SATISFIED: an already-issued token reached a tool handler"
    : "=> the transport answered but the handler did not");
})().catch((e) => { console.log("REFUSED:", e.message); process.exit(1); });
'
