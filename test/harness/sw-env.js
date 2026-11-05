/**
 * Loads background.js (a MV3 service worker) inside a Node VM with the
 * chrome.* surface mocked, so the real export pipeline can be exercised
 * in tests without a browser.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");

function makeListenerHub() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    _listeners: listeners,
    _emit: (...args) => listeners.map((fn) => fn(...args)),
  };
}

function createSwEnv(options = {}) {
  const storage = new Map(Object.entries(options.storage || {}));
  const downloads = [];
  const notifications = [];
  const tabMessages = [];
  const executedScripts = [];

  // fetch is opt-in per test; default refuses so nothing hits the network.
  const fetchImpl =
    options.fetch ||
    (async (url) => {
      throw new Error(`unexpected network fetch in test: ${url}`);
    });

  const chrome = {
    runtime: {
      lastError: null,
      id: "test-extension-id",
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      onMessage: makeListenerHub(),
    },
    storage: {
      local: {
        get: async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of wanted) if (storage.has(k)) out[k] = storage.get(k);
          return out;
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
        },
      },
    },
    tabs: {
      get: async (id) => ({ id, url: options.tabUrl || "https://claude.ai/chat/x" }),
      query: async () => [{ id: 1, url: options.tabUrl || "https://claude.ai/chat/x" }],
      update: async (id, props) => ({ id, ...props }),
      sendMessage: (tabId, msg, cb) => {
        tabMessages.push({ tabId, msg });
        const reply = options.onTabMessage ? options.onTabMessage(tabId, msg) : undefined;
        if (typeof cb === "function") cb(reply);
        return Promise.resolve(reply);
      },
      onUpdated: makeListenerHub(),
    },
    scripting: {
      executeScript: async (spec) => {
        executedScripts.push(spec);
        if (options.onExecuteScript) return options.onExecuteScript(spec);
        return [{ result: undefined }];
      },
    },
    webRequest: {
      onBeforeSendHeaders: makeListenerHub(),
      OnBeforeSendHeadersOptions: { EXTRA_HEADERS: "extraHeaders" },
    },
    downloads: {
      download: async (spec) => {
        downloads.push(spec);
        return downloads.length;
      },
    },
    notifications: {
      create: (opts, cb) => {
        notifications.push(opts);
        if (typeof cb === "function") cb("notif-id");
      },
    },
  };

  const sandbox = {
    chrome,
    console: options.console || console,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Date,
    Math,
    JSON,
    Error,
    Uint8Array,
    ArrayBuffer,
    Blob: globalThis.Blob,
    module: undefined,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);

  // background.js calls importScripts() at the top; load those into the
  // same context instead.
  sandbox.importScripts = (...files) => {
    for (const f of files) {
      const code = fs.readFileSync(path.join(ROOT, f), "utf8");
      vm.runInContext(code, context, { filename: f });
    }
  };

  const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  vm.runInContext(bg, context, { filename: "background.js" });

  return {
    context,
    sandbox,
    chrome,
    storage,
    downloads,
    notifications,
    tabMessages,
    executedScripts,
    /** Evaluate an expression against the service-worker scope. */
    run: (expr) => vm.runInContext(expr, context),
    /** Grab a top-level function/value declared in background.js. */
    get: (name) => vm.runInContext(name, context),
  };
}

module.exports = { createSwEnv };
