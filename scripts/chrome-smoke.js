#!/usr/bin/env node
/**
 * Loads the unpacked extension into a throwaway Chrome profile and inspects
 * the MV3 service worker over CDP. Verifies the worker registers, its
 * dependencies load, and its exported logic runs inside the real runtime.
 *
 * Usage: node scripts/chrome-smoke.js [--headful]
 * Exits non-zero if any check fails.
 */
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXT = path.resolve(__dirname, "..");
const PORT = 9333 + Math.floor(Math.random() * 400);
const HEADFUL = process.argv.includes("--headful");
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ceh-smoke-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
  return res.json();
}

async function waitForDevtools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await getJson("/json/version");
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chrome DevTools endpoint never came up");
}

/**
 * Chrome 137+ removed the --load-extension switch for security. Detect that
 * up front so the failure is actionable instead of a mystery timeout.
 */
function extensionRegistered(profileDir) {
  const glob = ["Preferences", "Secure Preferences"];
  for (const name of glob) {
    const p = path.join(profileDir, "Default", name);
    if (!fs.existsSync(p)) continue;
    try {
      const prefs = JSON.parse(fs.readFileSync(p, "utf8"));
      const settings = prefs?.extensions?.settings || {};
      for (const entry of Object.values(settings)) {
        if (String(entry?.path || "").includes(path.basename(EXT))) return true;
      }
    } catch {
      /* prefs may not be flushed yet */
    }
  }
  return false;
}

async function findServiceWorker(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await getJson("/json/list");
    const sw = targets.find(
      (t) => t.type === "service_worker" && t.url.includes("background.js"),
    );
    if (sw) return sw;
    // Wake a lazy MV3 worker by opening a page from the extension.
    const anyExtTarget = targets.find((t) => t.url.startsWith("chrome-extension://"));
    if (anyExtTarget) {
      const id = new URL(anyExtTarget.url).hostname;
      try {
        await fetch(
          `http://127.0.0.1:${PORT}/json/new?chrome-extension://${id}/popup.html`,
          { method: "PUT" },
        );
      } catch {
        /* best effort */
      }
    }
    await sleep(300);
  }
  const targets = await getJson("/json/list");
  throw new Error(
    "extension service worker never appeared. Targets:\n" +
      targets.map((t) => `  ${t.type} ${t.url}`).join("\n"),
  );
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  });
  return {
    ready,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      }),
    close: () => ws.close(),
  };
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

(async () => {
  console.log(`Chrome profile: ${profile}`);
  console.log(`Extension:      ${EXT}`);

  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "about:blank",
  ];
  if (!HEADFUL) args.unshift("--headless=new");

  const chrome = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (d) => (stderr += d.toString()));

  let client;
  try {
    const version = await waitForDevtools();
    console.log(`Browser:        ${version.Browser}\n`);

    if (!extensionRegistered(profile)) {
      throw new Error(
        [
          "Chrome did not load the unpacked extension.",
          "",
          "Chrome 137+ removed the --load-extension command-line switch, and no",
          "feature flag re-enables it (verified on Chrome stable and Canary).",
          "",
          "Use a Chrome for Testing binary, which still supports it:",
          "  npx @puppeteer/browsers install chrome@stable",
          "  CHROME_PATH=<path-to-chrome-for-testing> node scripts/chrome-smoke.js",
          "",
          "Everything except the live claude.ai fetch is already covered without a",
          "browser by: npm test  (see test/integration.test.js).",
        ].join("\n"),
      );
    }

    const sw = await findServiceWorker();
    check("service worker registered", true, sw.url.split("/").slice(0, 3).join("/"));

    client = cdp(sw.webSocketDebuggerUrl);
    await client.ready;
    await client.send("Runtime.enable");

    const evaluate = async (expression) => {
      const r = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || "eval failed");
      }
      return r.result.value;
    };

    check("JSZip loaded via importScripts", (await evaluate("typeof JSZip")) === "function");
    check("CadExportCore loaded", (await evaluate("typeof CadExportCore")) === "object");
    check(
      "chrome.downloads permission present",
      (await evaluate("typeof chrome.downloads.download")) === "function",
    );

    // Exercise the real parsing path inside the real service worker.
    const parsed = await evaluate(`(() => {
      const ROOT = "00000000-0000-4000-8000-000000000000";
      const payload = { uuid: "11111111-1111-4111-8111-111111111111", name: "SW Test",
        messages: [
          { uuid: "a", parent_message_uuid: ROOT, role: "user",
            content: [{ type: "text", text: "hello" }] },
          { uuid: "b", parent_message_uuid: "a", role: "assistant",
            content: [{ type: "text", text: "hi" }, { type: "thinking", thinking: "t" }] },
        ] };
      const branch = getActiveBranchMessages(payload);
      return {
        senders: branch.map(m => m.sender),
        markdown: buildChatMarkdown(payload),
        thinking: CadExportCore.collectThinkingFromPayload(payload).length,
      };
    })()`);

    check(
      "role-shaped payload resolves senders",
      JSON.stringify(parsed.senders) === '["human","assistant"]',
      JSON.stringify(parsed.senders),
    );
    check(
      "transcript labels Human and Assistant",
      parsed.markdown.includes("### Human") && parsed.markdown.includes("### Assistant"),
    );
    check("thinking extracted in real SW", parsed.thinking === 1, `${parsed.thinking} item(s)`);

    // A real ZIP, built by the real JSZip, inside the real worker.
    const zipNames = await evaluate(`(async () => {
      const ROOT = "00000000-0000-4000-8000-000000000000";
      const payload = { uuid: "22222222-2222-4222-8222-222222222222", name: "Zip Test",
        messages: [
          { uuid: "a", parent_message_uuid: ROOT, role: "user",
            content: [{ type: "text", text: "P".repeat(200) }] },
          { uuid: "b", parent_message_uuid: "a", role: "assistant",
            content: [{ type: "text", text: '<antArtifact title="app.py" language="python">x=1</antArtifact>' }] },
        ] };
      const zip = new JSZip();
      const prefix = buildChatFolderPrefix(payload);
      await writeStructuredChatToZip(zip, payload,
        { transcript: true, artifacts: true, pasted: true, thinking: false },
        prefix, []);
      const names = [];
      zip.forEach((p, e) => { if (!e.dir) names.push(p); });
      return names.sort();
    })()`);

    check("ZIP built inside the service worker", zipNames.length > 0, `${zipNames.length} files`);
    check(
      "artifact filename has no doubled extension",
      zipNames.some((n) => n.endsWith("/2_app.py")),
      zipNames.filter((n) => n.includes("artifacts/")).join(", ") || "none",
    );
    check("pasted/ populated", zipNames.some((n) => n.includes("/pasted/")));

    const swErrors = await evaluate(
      "typeof __cehErrors !== 'undefined' ? __cehErrors.length : 0",
    );
    check("no captured worker errors", swErrors === 0);
  } catch (err) {
    check("smoke run completed", false, err.message);
    if (stderr.trim()) console.log("\nchrome stderr:\n" + stderr.trim().split("\n").slice(-15).join("\n"));
  } finally {
    try { client?.close(); } catch {}
    chrome.kill("SIGTERM");
    await sleep(400);
    try { chrome.kill("SIGKILL"); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
