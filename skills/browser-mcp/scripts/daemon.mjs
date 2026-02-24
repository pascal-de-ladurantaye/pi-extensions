/**
 * Browser MCP daemon — bridges CLI commands to the Chrome extension.
 *
 * Architecture:
 *   WebSocket server (port 9009) ← Chrome extension connects here
 *   HTTP server (Unix socket)    ← CLI client sends commands here
 *
 * The Chrome extension protocol sends { id, type, payload } and responds
 * with { type: "messageResponse", payload: { requestId, result?, error? } }.
 */

import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const WS_PORT = parseInt(process.env.BROWSER_MCP_WS_PORT || "9009");
const SOCK_PATH = process.env.BROWSER_MCP_SOCK || "/tmp/browser-mcp.sock";
const PID_FILE = process.env.BROWSER_MCP_PID || "/tmp/browser-mcp.pid";
const OUTPUT_DIR = process.env.BROWSER_MCP_OUTPUT || "/tmp/browser-mcp";
const RESPONSE_TIMEOUT_MS = 30_000;

let extensionWs = null;

// ---------------------------------------------------------------------------
// WebSocket server — Chrome extension connects here
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: WS_PORT });

wss.on("connection", (ws) => {
  console.log("[ws] Chrome extension connected");
  if (extensionWs && extensionWs.readyState === WebSocket.OPEN) {
    extensionWs.close();
  }
  extensionWs = ws;
  ws.on("close", () => {
    console.log("[ws] Chrome extension disconnected");
    if (extensionWs === ws) extensionWs = null;
  });
  ws.on("error", (err) => {
    console.error("[ws] error:", err.message);
  });
});

wss.on("listening", () => {
  console.log(`[ws] Listening on port ${WS_PORT}`);
});

wss.on("error", (err) => {
  console.error(`[ws] Failed to start on port ${WS_PORT}: ${err.message}`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Send a message to the Chrome extension and wait for the response
// ---------------------------------------------------------------------------

function sendToExtension(type, payload, timeoutMs = RESPONSE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
      reject(
        new Error(
          "No browser extension connected. Open Chrome, click the Browser MCP extension icon, and press Connect."
        )
      );
      return;
    }

    const id = crypto.randomUUID();

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for extension response (${timeoutMs}ms)`));
    }, timeoutMs);

    function onMessage(event) {
      let msg;
      try {
        msg = JSON.parse(event.data.toString());
      } catch {
        return;
      }
      if (msg.type !== "messageResponse") return;
      if (msg.payload?.requestId !== id) return;

      cleanup();
      if (msg.payload.error) {
        reject(new Error(msg.payload.error));
      } else {
        resolve(msg.payload.result);
      }
    }

    function cleanup() {
      clearTimeout(timer);
      extensionWs?.removeEventListener("message", onMessage);
    }

    extensionWs.addEventListener("message", onMessage);
    extensionWs.send(JSON.stringify({ id, type, payload }));
  });
}

// ---------------------------------------------------------------------------
// Capture ARIA snapshot (URL + title + accessibility tree) and save to file
// ---------------------------------------------------------------------------

async function captureSnapshot(prefix = "") {
  const [url, title, snapshot] = await Promise.all([
    sendToExtension("getUrl", undefined),
    sendToExtension("getTitle", undefined),
    sendToExtension("browser_snapshot", {}),
  ]);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `snapshot-${ts}.yaml`;
  const filepath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filepath, snapshot);

  return [
    prefix,
    `- Page URL: ${url}`,
    `- Page Title: ${title}`,
    `- Page Snapshot: ${filepath}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const handlers = {
  async status() {
    const connected = extensionWs?.readyState === WebSocket.OPEN;
    if (!connected) return "Daemon running. No browser extension connected.";
    try {
      const url = await sendToExtension("getUrl", undefined);
      return `Daemon running. Extension connected.\nCurrent page: ${url}`;
    } catch {
      return "Daemon running. Extension connected but not responding.";
    }
  },

  async navigate({ url }) {
    await sendToExtension("browser_navigate", { url });
    return captureSnapshot();
  },

  async "go-back"() {
    await sendToExtension("browser_go_back", {});
    return captureSnapshot("Navigated back");
  },

  async "go-forward"() {
    await sendToExtension("browser_go_forward", {});
    return captureSnapshot("Navigated forward");
  },

  async snapshot() {
    return captureSnapshot();
  },

  async click({ element, ref }) {
    await sendToExtension("browser_click", { element, ref });
    return captureSnapshot(`Clicked "${element}"`);
  },

  async hover({ element, ref }) {
    await sendToExtension("browser_hover", { element, ref });
    return captureSnapshot(`Hovered over "${element}"`);
  },

  async type({ element, ref, text, submit }) {
    await sendToExtension("browser_type", {
      element,
      ref,
      text,
      submit: !!submit,
    });
    return captureSnapshot(`Typed "${text}" into "${element}"`);
  },

  async select({ element, ref, values }) {
    await sendToExtension("browser_select_option", { element, ref, values });
    return captureSnapshot(`Selected option in "${element}"`);
  },

  async drag({ startElement, startRef, endElement, endRef }) {
    await sendToExtension("browser_drag", {
      startElement,
      startRef,
      endElement,
      endRef,
    });
    return captureSnapshot(
      `Dragged "${startElement}" to "${endElement}"`
    );
  },

  async "press-key"({ key }) {
    await sendToExtension("browser_press_key", { key });
    return `Pressed key: ${key}`;
  },

  async wait({ time }) {
    await sendToExtension("browser_wait", { time: Number(time) });
    return `Waited ${time} seconds`;
  },

  async screenshot({ filename }) {
    const data = await sendToExtension("browser_screenshot", {});
    let outPath;
    if (filename && path.isAbsolute(filename)) {
      outPath = filename;
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
    } else {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      outPath = path.join(OUTPUT_DIR, filename || `screenshot-${ts}.png`);
    }
    fs.writeFileSync(outPath, Buffer.from(data, "base64"));
    return `Screenshot saved: ${outPath}`;
  },

  async console() {
    const logs = await sendToExtension("browser_get_console_logs", {});
    if (!logs || logs.length === 0) return "No console logs.";
    return logs.map((log) => JSON.stringify(log)).join("\n");
  },
};

// ---------------------------------------------------------------------------
// HTTP server on Unix socket — CLI client talks to us here
// ---------------------------------------------------------------------------

if (fs.existsSync(SOCK_PATH)) fs.unlinkSync(SOCK_PATH);

const httpServer = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/command") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", async () => {
    try {
      const { command, args } = JSON.parse(body);
      const handler = handlers[command];
      if (!handler) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown command: ${command}` }));
        return;
      }
      const result = await handler(args || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

httpServer.listen(SOCK_PATH, () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log(`[ipc] Socket: ${SOCK_PATH}`);
  console.log(`[ipc] PID file: ${PID_FILE}`);
  console.log("[daemon] Ready. Waiting for Chrome extension connection...");
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown() {
  console.log("[daemon] Shutting down...");
  if (extensionWs) extensionWs.close();
  wss.close();
  httpServer.close();
  try { fs.unlinkSync(SOCK_PATH); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
