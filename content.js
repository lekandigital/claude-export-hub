const LOG_PREFIX = "[Claude Export Hub]";
const CHAT_UUID_PATTERN = /\/chat\/([0-9a-f-]{36})/i;
const CHAT_PAGE_PATTERN = /^https:\/\/claude\.ai\/chat\/[^/]+/i;
const PREFS_KEY = "exportPreferences";

function collectVisibleThinkingFromDom() {
  if (typeof CadExportCore?.collectVisibleStatusFromDom === "function") {
    return CadExportCore.collectVisibleStatusFromDom(document);
  }
  return [];
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function preparePageForThinkingScrape(options = {}) {
  window.scrollTo(0, document.body.scrollHeight);
  await delayMs(250);
  window.scrollTo(0, 0);
  await delayMs(150);

  let expandedCount = 0;
  if (options.expandPanels !== false) {
    const collapsed = [
      ...document.querySelectorAll(
        'button[class*="group/status"][aria-expanded="false"]',
      ),
    ];
    for (const button of collapsed) {
      button.click();
      expandedCount += 1;
    }
    if (expandedCount > 0) {
      await delayMs(options.expandDelayMs || 600);
    }
  }

  return expandedCount;
}

function probeChatDomReady() {
  const statusCount = document.querySelectorAll(
    'button[class*="group/status"]',
  ).length;
  const responseCount = document.querySelectorAll(
    '.font-claude-response-body, [class*="font-claude-response"]',
  ).length;
  const humanCount = document.querySelectorAll(
    "textarea, .font-user-message",
  ).length;

  return {
    ready: statusCount > 0 || responseCount > 0 || humanCount > 0,
    statusCount,
    responseCount,
    humanCount,
  };
}

function extractChatUuid(url) {
  const match = url.match(CHAT_UUID_PATTERN);
  return match ? match[1] : null;
}

function isChatPage(url) {
  return CHAT_PAGE_PATTERN.test(url);
}

function injectExportStyles() {
  if (document.getElementById("claude-export-hub-styles")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "claude-export-hub-styles";
  style.textContent = `
    .ceh-fab {
      position: fixed;
      bottom: 88px;
      right: 16px;
      z-index: 2147483640;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .ceh-fab-trigger {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: none;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 14px rgba(99,102,241,0.45), 0 1px 3px rgba(0,0,0,0.12);
      transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s ease;
    }
    .ceh-fab-trigger:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 20px rgba(99,102,241,0.55), 0 2px 6px rgba(0,0,0,0.15);
    }
    .ceh-fab-trigger:active {
      transform: scale(0.95);
    }
    .ceh-fab-trigger svg {
      transition: transform 0.25s ease;
    }
    .ceh-fab.open .ceh-fab-trigger svg {
      transform: rotate(180deg);
    }
    .ceh-panel {
      position: absolute;
      bottom: 54px;
      right: 0;
      width: 220px;
      background: #1e1e2e;
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06);
      padding: 0;
      opacity: 0;
      transform: translateY(8px) scale(0.95);
      transform-origin: bottom right;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.34,1.56,0.64,1);
      overflow: hidden;
    }
    .ceh-fab.open .ceh-panel {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    .ceh-panel-header {
      padding: 12px 14px 8px;
      font-size: 11px;
      font-weight: 600;
      color: #a1a1b5;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .ceh-panel-options {
      padding: 0 6px 6px;
    }
    .ceh-option {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 8px;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s ease;
      font-size: 13px;
      color: #e0e0ec;
      user-select: none;
    }
    .ceh-option:hover {
      background: rgba(255,255,255,0.06);
    }
    .ceh-option input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      border-radius: 4px;
      border: 1.5px solid #4a4a5e;
      background: transparent;
      cursor: pointer;
      position: relative;
      flex-shrink: 0;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .ceh-option input[type="checkbox"]:checked {
      background: #6366f1;
      border-color: #6366f1;
    }
    .ceh-option input[type="checkbox"]:checked::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 5px;
      width: 4px;
      height: 8px;
      border: solid white;
      border-width: 0 1.5px 1.5px 0;
      transform: rotate(45deg);
    }
    .ceh-divider {
      height: 1px;
      background: rgba(255,255,255,0.06);
      margin: 4px 10px;
    }
    .ceh-panel-actions {
      padding: 6px;
    }
    .ceh-export-btn {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 9px 12px;
      border: none;
      border-radius: 8px;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s ease, transform 0.1s ease;
    }
    .ceh-export-btn:hover {
      opacity: 0.9;
    }
    .ceh-export-btn:active {
      transform: scale(0.97);
    }
    .ceh-bulk-btn {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 7px 12px;
      margin-top: 4px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      background: transparent;
      color: #a1a1b5;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .ceh-bulk-btn:hover {
      background: rgba(255,255,255,0.06);
      color: #e0e0ec;
    }
  `;
  document.head.appendChild(style);
}

function createDownloadContainer() {
  injectExportStyles();

  const fab = document.createElement("div");
  fab.className = "ceh-fab";
  fab.setAttribute("data-claude-downloader", "true");

  // The trigger button
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "ceh-fab-trigger claude-download-button";
  trigger.title = "Export this chat";
  trigger.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

  // The dropdown panel
  const panel = document.createElement("div");
  panel.className = "ceh-panel";

  const header = document.createElement("div");
  header.className = "ceh-panel-header";
  header.textContent = "Include in export";
  panel.appendChild(header);

  const optionsWrap = document.createElement("div");
  optionsWrap.className = "ceh-panel-options";

  const options = [
    { id: "transcript", label: "Transcript", defaultOn: true },
    { id: "artifacts", label: "Artifacts", defaultOn: true },
    { id: "pasted", label: "Pasted content", defaultOn: true },
    { id: "thinking", label: "Visible thinking", defaultOn: true },
  ];

  for (const opt of options) {
    const label = document.createElement("label");
    label.className = "ceh-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = `claude-include-${opt.id}`;
    checkbox.checked = opt.defaultOn;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(opt.label));
    optionsWrap.appendChild(label);
  }
  panel.appendChild(optionsWrap);

  const divider = document.createElement("div");
  divider.className = "ceh-divider";
  panel.appendChild(divider);

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "ceh-panel-actions";

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "ceh-export-btn";
  exportBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Export this chat`;
  exportBtn.addEventListener("click", () => {
    downloadArtifacts();
    fab.classList.remove("open");
  });
  actionsWrap.appendChild(exportBtn);

  const bulkBtn = document.createElement("button");
  bulkBtn.type = "button";
  bulkBtn.className = "ceh-bulk-btn";
  bulkBtn.textContent = "Bulk export…";
  bulkBtn.title = "Open extension popup for multi-chat export";
  bulkBtn.addEventListener("click", async () => {
    fab.classList.remove("open");
    try {
      if (chrome.action?.openPopup) {
        await chrome.action.openPopup();
        return;
      }
    } catch {
      // openPopup requires a user gesture and may be unavailable
    }
    createBanner(
      "Click the extension icon for bulk export (pick chats or export all).",
      "success",
      4000,
    );
  });
  actionsWrap.appendChild(bulkBtn);

  panel.appendChild(actionsWrap);

  // Toggle logic
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    fab.classList.toggle("open");
  });

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (!fab.contains(e.target)) {
      fab.classList.remove("open");
    }
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      fab.classList.remove("open");
    }
  });

  fab.appendChild(panel);
  fab.appendChild(trigger);
  return fab;
}

function injectFloatingButton() {
  if (document.querySelector(".claude-download-button")) {
    return false;
  }

  const fab = createDownloadContainer();
  document.body.appendChild(fab);
  loadIncludePrefs();
  console.log(
    LOG_PREFIX,
    "button injected successfully (floating FAB, bottom-right)",
  );
  return true;
}

function addDownloadButton() {
  if (document.querySelector(".claude-download-button")) {
    console.log(LOG_PREFIX, "injection skipped, button already exists");
    return false;
  }

  if (injectFloatingButton()) {
    return true;
  }

  console.warn(LOG_PREFIX, "no safe insertion target found");
  return false;
}

function getExportIncludesFromPage() {
  return {
    transcript:
      document.querySelector(".claude-include-transcript")?.checked ?? true,
    artifacts:
      document.querySelector(".claude-include-artifacts")?.checked ?? true,
    pasted: document.querySelector(".claude-include-pasted")?.checked ?? true,
    thinking:
      document.querySelector(".claude-include-thinking")?.checked ?? true,
  };
}

function loadIncludePrefs() {
  chrome.storage.local.get([PREFS_KEY], (result) => {
    const includes = result[PREFS_KEY]?.includes;
    if (!includes) {
      return;
    }
    const map = {
      transcript: ".claude-include-transcript",
      artifacts: ".claude-include-artifacts",
      pasted: ".claude-include-pasted",
      thinking: ".claude-include-thinking",
    };
    for (const [key, selector] of Object.entries(map)) {
      const el = document.querySelector(selector);
      if (el && includes[key] !== undefined) {
        el.checked = includes[key] !== false;
      }
    }
  });
}

function getIncludeSummary() {
  const includes = getExportIncludesFromPage();
  const parts = [];
  if (includes.transcript) {
    parts.push("transcript");
  }
  if (includes.artifacts) {
    parts.push("artifacts");
  }
  if (includes.pasted) {
    parts.push("pasted");
  }
  if (includes.thinking) {
    parts.push("visible thinking");
  }
  return parts.join(", ") || "nothing";
}

function downloadArtifacts() {
  const uuid = extractChatUuid(window.location.href);
  if (!uuid) {
    createBanner("No conversation UUID found in URL.", "error", 3000);
    return;
  }

  const exportIncludes = getExportIncludesFromPage();
  if (
    !exportIncludes.transcript &&
    !exportIncludes.artifacts &&
    !exportIncludes.pasted &&
    !exportIncludes.thinking
  ) {
    createBanner("Select at least one content type to export.", "error", 3000);
    return;
  }

  console.log(LOG_PREFIX, "export requested for", uuid);
  createBanner(`Exporting ${getIncludeSummary()}…`, "success", 2000);

  chrome.runtime.sendMessage(
    {
      action: "downloadArtifacts",
      uuid: uuid,
      exportIncludes,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message;
        console.log(LOG_PREFIX, "export failure:", msg);
        createBanner(msg, "error", 3000);
        return;
      }
      if (response?.success) {
        console.log(LOG_PREFIX, "export success:", response.message);
      } else if (response?.error) {
        console.log(LOG_PREFIX, "export failure:", response.error);
        createBanner(response.error, "error", 3000);
      }
    },
  );
}

let domObserver = null;
let thinkingObserver = null;
let thinkingDebounceTimer = null;

function flushThinkingCache() {
  if (!chrome.runtime?.id) {
    if (thinkingObserver) {
      thinkingObserver.disconnect();
      thinkingObserver = null;
    }
    return;
  }

  const uuid = extractChatUuid(window.location.href);
  if (!uuid) {
    return;
  }

  const blocks = collectVisibleThinkingFromDom();
  if (blocks.length) {
    console.log(
      LOG_PREFIX,
      "cached visible status/thinking blocks:",
      blocks.length,
    );
  }

  chrome.runtime.sendMessage(
    {
      action: "cacheVisibleThinking",
      uuid,
      blocks,
      updatedAt: Date.now(),
    },
    () => {
      void chrome.runtime.lastError;
    },
  );
}

function scheduleThinkingCacheUpdate() {
  clearTimeout(thinkingDebounceTimer);
  thinkingDebounceTimer = setTimeout(flushThinkingCache, 400);
}

function startThinkingObserver() {
  if (thinkingObserver || !isChatPage(window.location.href)) {
    return;
  }

  thinkingObserver = new MutationObserver(() => {
    scheduleThinkingCacheUpdate();
  });

  thinkingObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  setTimeout(flushThinkingCache, 500);
}

function startDomObserver() {
  if (domObserver) {
    return;
  }

  domObserver = new MutationObserver(() => {
    if (addDownloadButton()) {
      domObserver.disconnect();
      domObserver = null;
    }
  });

  domObserver.observe(document.body, { childList: true, subtree: true });

  setTimeout(() => {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
      console.warn(
        LOG_PREFIX,
        "MutationObserver timed out without finding container",
      );
    }
  }, 30000);
}

function checkAndAddShareButtons() {
  if (!isChatPage(window.location.href)) {
    console.log(LOG_PREFIX, "not a chat page, skipping button injection");
    return;
  }

  startThinkingObserver();

  const uuid = extractChatUuid(window.location.href);
  if (uuid) {
    console.log(LOG_PREFIX, "extracted conversation UUID from URL:", uuid);
  }

  const maxAttempts = 15;
  let attempts = 0;

  function tryAddButtons() {
    if (document.querySelector(".claude-download-button")) {
      console.log(LOG_PREFIX, "injection skipped, button already exists");
      return;
    }

    attempts++;
    console.log(
      LOG_PREFIX,
      `attempting button injection (attempt ${attempts}/${maxAttempts})`,
    );

    if (addDownloadButton()) {
      return;
    }

    if (attempts < maxAttempts) {
      setTimeout(tryAddButtons, 1000);
    } else {
      console.warn(
        LOG_PREFIX,
        `container not found after ${maxAttempts} attempts, starting MutationObserver`,
      );
      startDomObserver();
    }
  }

  tryAddButtons();
}

console.log(LOG_PREFIX, "content script loaded on", window.location.href);

if (!(globalThis.__cadExportHubLoaded && chrome.runtime?.id)) {
  globalThis.__cadExportHubLoaded = true;
  checkAndAddShareButtons();
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "ping") {
    sendResponse({ ok: !!chrome.runtime?.id });
    return false;
  }

  if (request.action === "listenForPayload") {
    const eventName = `cad-payload-${request.uuid}`;
    console.log(LOG_PREFIX, "listening for page payload event:", eventName);
    document.addEventListener(
      eventName,
      (event) => {
        const detail = event.detail ?? {
          payload: null,
          error: "empty page payload event",
        };
        sendResponse(detail);
      },
      { once: true },
    );
    return true;
  }

  if (request.action === "listenForConversationList") {
    const eventName = request.eventName;
    console.log(LOG_PREFIX, "listening for conversation list event:", eventName);
    document.addEventListener(
      eventName,
      (event) => {
        const detail = event.detail ?? {
          conversations: [],
          error: "empty conversation list event",
        };
        sendResponse(detail);
      },
      { once: true },
    );
    return true;
  }

  if (request.action === "getVisibleThinking") {
    const currentUuid = extractChatUuid(window.location.href);
    if (currentUuid !== request.uuid) {
      sendResponse({ blocks: [] });
      return false;
    }
    sendResponse({ blocks: collectVisibleThinkingFromDom() });
    return false;
  }

  if (request.action === "probeChatDom") {
    const currentUuid = extractChatUuid(window.location.href);
    if (currentUuid !== request.uuid) {
      sendResponse({
        ready: false,
        reason: "wrong-url",
        currentUuid,
      });
      return false;
    }
    sendResponse(probeChatDomReady());
    return false;
  }

  if (request.action === "scrapeVisibleThinking") {
    const currentUuid = extractChatUuid(window.location.href);
    if (currentUuid !== request.uuid) {
      sendResponse({ blocks: [], error: "wrong chat page" });
      return false;
    }

    preparePageForThinkingScrape({
      expandPanels: request.expandPanels !== false,
      expandDelayMs: request.expandDelayMs,
    })
      .then((expandedCount) => {
        const blocks = collectVisibleThinkingFromDom();
        sendResponse({ blocks, expandedCount });
      })
      .catch((error) => {
        sendResponse({ blocks: [], error: error.message });
      });
    return true;
  }

  if (request.action === "artifactsProcessed") {
    if (request.success) {
      console.log(LOG_PREFIX, "export success:", request.message);
      const summary = request.message?.split("\n")[0] || request.message;
      createBanner(summary, "success", 3000);
    } else if (request.failure) {
      console.log(LOG_PREFIX, "export failure:", request.message);
      createBanner(request.message, "error", 3000);
    } else if (request.message) {
      console.log(LOG_PREFIX, "export failure:", request.message);
      createBanner(request.message, "error", 3000);
    }
  } else if (request.action === "exportProgress") {
    const job = request.job;
    if (!job) {
      return;
    }
    if (job.status === "running" || job.status === "cancelling") {
      const total = job.total || 1;
      const current = job.current || 0;
      const progressKey = `${current}/${total}`;
      if (
        window.__cadLastProgressKey === progressKey &&
        current % 5 !== 0 &&
        current !== total
      ) {
        return;
      }
      window.__cadLastProgressKey = progressKey;
      const name = job.currentChatName ? ` — ${job.currentChatName}` : "";
      createBanner(`Exporting ${current}/${total}${name}`, "success", 1500);
    }
  } else if (request.action === "checkAndAddDownloadButton") {
    checkAndAddShareButtons();
  }
});
