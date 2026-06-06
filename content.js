const LOG_PREFIX = "[Claude Export Hub]";
const CHAT_UUID_PATTERN = /\/chat\/([0-9a-f-]{36})/i;
const CHAT_PAGE_PATTERN = /^https:\/\/claude\.ai\/chat\/[^/]+/i;
const PREFS_KEY = "exportPreferences";

function cleanText(text) {
  return String(text || "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function looksLikeThinkingTitle(title) {
  if (!title) {
    return false;
  }

  const lower = title.toLowerCase();

  if (lower.includes("thinking")) {
    return true;
  }
  if (lower.includes("synthesizing")) {
    return true;
  }
  if (lower.includes("analyzing")) {
    return true;
  }
  if (lower.includes("reviewing")) {
    return true;
  }
  if (lower.includes("checking")) {
    return true;
  }
  if (lower.includes("curating")) {
    return true;
  }
  if (lower.includes("planning")) {
    return true;
  }
  if (lower.includes("extracting")) {
    return true;
  }

  return false;
}

function dedupeTitleFromBody(title, body) {
  let output = body.trim();

  while (output.startsWith(title)) {
    output = output.slice(title.length).trim();
  }

  return output;
}

function collectVisibleThinkingFromDom() {
  const turns = [...document.querySelectorAll("[data-is-streaming]")];
  const results = [];

  for (const [turnIndex, turn] of turns.entries()) {
    const statusButtons = [...turn.querySelectorAll("button[aria-expanded]")];

    for (const [blockIndex, button] of statusButtons.entries()) {
      const title = cleanText(button.innerText);

      if (!looksLikeThinkingTitle(title)) {
        continue;
      }

      const blockRoot =
        button.closest(".grid") ||
        button.closest("[class*='grid-rows']") ||
        button.parentElement?.parentElement?.parentElement;

      const bodyCandidates = [
        blockRoot?.querySelector("[class*='row-start-2']"),
        blockRoot?.querySelector("[class*='font-ui']"),
        blockRoot,
      ].filter(Boolean);

      const body = cleanText(
        bodyCandidates
          .map((el) => el.innerText || "")
          .sort((a, b) => b.length - a.length)[0] || "",
      );

      const content = dedupeTitleFromBody(title, body);

      if (content && content.length > 40) {
        results.push({
          source: "dom",
          turnIndex,
          blockIndex,
          title,
          content,
          streaming: turn.getAttribute("data-is-streaming") === "true",
        });
      }
    }
  }

  return results;
}

function extractChatUuid(url) {
  const match = url.match(CHAT_UUID_PATTERN);
  return match ? match[1] : null;
}

function isChatPage(url) {
  return CHAT_PAGE_PATTERN.test(url);
}

function createDownloadContainer() {
  const downloadContainer = document.createElement("div");
  downloadContainer.className =
    "claude-download-container flex items-center gap-2 shrink-0";
  downloadContainer.setAttribute("data-claude-downloader", "true");

  const menuButton = createMenuButton();
  const includesPanel = createIncludesPanel();
  const downloadButton = createButton("Export this chat");

  downloadContainer.appendChild(menuButton);
  downloadContainer.appendChild(includesPanel);
  downloadContainer.appendChild(downloadButton);
  return downloadContainer;
}

function injectFloatingButton() {
  if (document.querySelector(".claude-download-button")) {
    return false;
  }

  const downloadContainer = createDownloadContainer();
  downloadContainer.style.cssText =
    "position: fixed; bottom: 88px; right: 16px; z-index: 40; display: flex; align-items: center; gap: 6px; pointer-events: auto;";

  document.body.appendChild(downloadContainer);
  loadIncludePrefs();
  console.log(
    LOG_PREFIX,
    "button injected successfully (floating, bottom-right)",
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

function createButton(text) {
  const button = document.createElement("button");
  button.className =
    "claude-download-button flex items-center rounded-md bg-gray-100 py-1 px-3 text-sm font-medium text-gray-800 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 shadow-md";
  button.type = "button";
  button.title =
    "Saves chat.md, artifacts/, pasted/, and thinking/ per your checkboxes";
  button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>${text}`;
  button.addEventListener("click", downloadArtifacts);
  return button;
}

function createIncludesPanel() {
  const panel = document.createElement("div");
  panel.className = "claude-download-includes";
  panel.style.cssText =
    "display:flex;align-items:center;gap:6px;background:#f3f4f6;border-radius:6px;padding:2px 6px;box-shadow:0 1px 2px rgba(0,0,0,0.08);font-size:11px;color:#374151;";

  const options = [
    { id: "transcript", label: "Transcript", defaultOn: true },
    { id: "artifacts", label: "Artifacts", defaultOn: true },
    { id: "pasted", label: "Pasted", defaultOn: true },
    { id: "thinking", label: "Visible thinking", defaultOn: true },
  ];

  for (const opt of options) {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:3px;cursor:pointer;";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = `claude-include-${opt.id}`;
    checkbox.checked = opt.defaultOn;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(opt.label));
    panel.appendChild(label);
  }

  return panel;
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

function createMenuButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "claude-download-menu rounded-md bg-gray-100 py-1 px-2 text-sm font-medium text-gray-800 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 shadow-md";
  button.title = "More export options (pick chats, export all)";
  button.textContent = "⋯";
  button.addEventListener("click", async () => {
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
  return button;
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
