#!/usr/bin/env node

/**
 * Browser MCP CLI — sends commands to the daemon and prints results.
 *
 * Lifecycle:   browser-mcp start | stop | status
 * Commands:    browser-mcp <command> [args...]
 */

import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCK_PATH = process.env.BROWSER_MCP_SOCK || "/tmp/browser-mcp.sock";
const PID_FILE = process.env.BROWSER_MCP_PID || "/tmp/browser-mcp.pid";
const LOG_FILE = process.env.BROWSER_MCP_LOG || "/tmp/browser-mcp.log";

// ---------------------------------------------------------------------------
// IPC — send a command to the daemon via the Unix socket
// ---------------------------------------------------------------------------

function sendCommand(command, args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ command, args });
    const req = http.request(
      {
        socketPath: SOCK_PATH,
        path: "/command",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            if (json.error) reject(new Error(json.error));
            else resolve(json.result);
          } catch {
            reject(new Error(`Invalid daemon response: ${body}`));
          }
        });
      }
    );
    req.on("error", (err) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        reject(new Error("Daemon not running. Start with: browser-mcp start"));
      } else {
        reject(err);
      }
    });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Daemon lifecycle helpers
// ---------------------------------------------------------------------------

function isDaemonRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim());
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

function startDaemon() {
  if (isDaemonRunning()) {
    console.log("Daemon already running.");
    return;
  }

  // Clean stale files
  try { fs.unlinkSync(SOCK_PATH); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}

  const logFd = fs.openSync(LOG_FILE, "a");
  const child = spawn("node", [path.join(__dirname, "daemon.mjs")], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      BROWSER_MCP_SOCK: SOCK_PATH,
      BROWSER_MCP_PID: PID_FILE,
    },
  });
  child.unref();
  fs.closeSync(logFd);

  // Poll until the daemon socket appears
  const start = Date.now();
  const poll = () => {
    if (fs.existsSync(SOCK_PATH)) {
      console.log(`Browser MCP daemon started (pid ${child.pid})`);
      console.log(`WebSocket: ws://localhost:9009`);
      console.log(`Log file:  ${LOG_FILE}`);
      console.log(
        "\nOpen Chrome → click Browser MCP extension icon → Connect"
      );
      return;
    }
    if (Date.now() - start > 5000) {
      console.error(`Daemon failed to start. Check ${LOG_FILE}`);
      process.exit(1);
    }
    setTimeout(poll, 100);
  };
  poll();
}

function stopDaemon() {
  if (!isDaemonRunning()) {
    console.log("Daemon not running.");
    try { fs.unlinkSync(SOCK_PATH); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim());
  process.kill(pid, "SIGTERM");
  console.log(`Daemon stopped (pid ${pid}).`);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const USAGE = `Usage: browser-mcp <command> [args...]

Lifecycle:
  start                                    Start the daemon
  stop                                     Stop the daemon
  status                                   Check daemon & extension status

Navigation:
  navigate <url>                           Navigate to URL
  go-back                                  Go back
  go-forward                               Go forward

Page State:
  snapshot                                 Capture accessibility snapshot
  screenshot [--filename=NAME]             Take screenshot

Interaction:
  click <element> <ref>                    Click an element
  type <element> <ref> <text> [--submit]   Type into element
  hover <element> <ref>                    Hover over element
  select <element> <ref> <val...>          Select dropdown option(s)
  drag <sEl> <sRef> <eEl> <eRef>           Drag and drop

Keyboard:
  press-key <key>                          Press a key (Enter, ArrowDown, a, …)

Utility:
  wait <seconds>                           Wait
  console                                  Get browser console logs`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2);
const command = argv[0];

if (!command || command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exit(0);
}

// Lifecycle commands (handled locally, no daemon needed)
if (command === "start") {
  startDaemon();
} else if (command === "stop") {
  stopDaemon();
} else {
  // All other commands are forwarded to the daemon
  const cmdArgs = {};

  switch (command) {
    case "navigate":
      cmdArgs.url = argv[1];
      if (!cmdArgs.url) die("Usage: browser-mcp navigate <url>");
      break;

    case "click":
      cmdArgs.element = argv[1];
      cmdArgs.ref = argv[2];
      if (!cmdArgs.element || !cmdArgs.ref)
        die("Usage: browser-mcp click <element> <ref>");
      break;

    case "hover":
      cmdArgs.element = argv[1];
      cmdArgs.ref = argv[2];
      if (!cmdArgs.element || !cmdArgs.ref)
        die("Usage: browser-mcp hover <element> <ref>");
      break;

    case "type": {
      cmdArgs.element = argv[1];
      cmdArgs.ref = argv[2];
      cmdArgs.text = argv[3];
      cmdArgs.submit = argv.includes("--submit");
      if (!cmdArgs.element || !cmdArgs.ref || !cmdArgs.text)
        die("Usage: browser-mcp type <element> <ref> <text> [--submit]");
      break;
    }

    case "select": {
      cmdArgs.element = argv[1];
      cmdArgs.ref = argv[2];
      cmdArgs.values = argv.slice(3).filter((a) => !a.startsWith("--"));
      if (!cmdArgs.element || !cmdArgs.ref || cmdArgs.values.length === 0)
        die("Usage: browser-mcp select <element> <ref> <value1> [value2...]");
      break;
    }

    case "drag":
      cmdArgs.startElement = argv[1];
      cmdArgs.startRef = argv[2];
      cmdArgs.endElement = argv[3];
      cmdArgs.endRef = argv[4];
      if (
        !cmdArgs.startElement ||
        !cmdArgs.startRef ||
        !cmdArgs.endElement ||
        !cmdArgs.endRef
      )
        die("Usage: browser-mcp drag <startEl> <startRef> <endEl> <endRef>");
      break;

    case "press-key":
      cmdArgs.key = argv[1];
      if (!cmdArgs.key) die("Usage: browser-mcp press-key <key>");
      break;

    case "wait":
      cmdArgs.time = parseFloat(argv[1]);
      if (isNaN(cmdArgs.time)) die("Usage: browser-mcp wait <seconds>");
      break;

    case "screenshot": {
      const flag = argv.find((a) => a.startsWith("--filename="));
      if (flag) cmdArgs.filename = flag.split("=")[1];
      break;
    }

    case "status":
    case "snapshot":
    case "go-back":
    case "go-forward":
    case "console":
      break;

    default:
      die(`Unknown command: ${command}\n\n${USAGE}`);
  }

  try {
    const result = await sendCommand(command, cmdArgs);
    console.log(result);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
