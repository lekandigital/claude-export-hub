// background.js
importScripts("jszip.min.js", "lib/export-core.js");

const {
  normalizeChatPayload,
  isStorableChatPayload,
  isValidChatPayload,
  getActiveBranchMessages,
  getMostRecentRootMessage,
  getMessageText,
  stripArtifactsFromText,
  getAttachmentExcerpts,
  collectCategorizedItemsFromPayload,
  collectThinkingFromPayload,
  thinkingDedupeKey,
  extractArtifacts,
  inferPastedTitle,
  getUniqueFileName,
  buildExportDiagnostics,
  logExportDiagnostics,
} = CadExportCore;

function sanitizeFilename(name) {
  const sanitized = (name || "claude-artifacts")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/[\x00-\x1f]/g, "")
    .trim();
  return sanitized || "claude-artifacts";
}

const LOG_PREFIX = "[Claude Export Hub]";
const CHAT_URL_PATTERN = /^https:\/\/claude\.ai\/chat\/[^/]+/;
const CLAUDE_URL_PATTERN = /^https:\/\/claude\.ai/;
const ORG_API_URLS = [
  "https://claude.ai/api/organizations",
  "https://api.claude.ai/api/organizations",
];
const EXPORT_JOB_KEY = "exportJob";
const CHAT_FETCH_DELAY_MS = 150;
const LIST_PAGE_SIZE = 50;
const DOM_SCRAPE_TIMEOUT_MS = 25000;
const DOM_SCRAPE_POLL_MS = 500;
const DOM_SCRAPE_RENDER_DELAY_MS = 1500;
const DOM_SCRAPE_EXPAND_DELAY_MS = 600;

function collectChatOrgIds(data) {
  const orgs = Array.isArray(data)
    ? data
    : data.organizations || data.data || [];
  return orgs
    .filter((org) => {
      const caps = org.capabilities;
      return !caps || caps.includes("chat");
    })
    .map((org) => org.uuid || org.id)
    .filter(Boolean);
}

const API_HOSTS = ["https://claude.ai", "https://api.claude.ai"];

const CONVERSATION_PARAM_SETS = [
  { tree: "True", rendering_mode: "messages", render_all_tools: "true" },
  { tree: "True", rendering_mode: "raw" },
];

let jobCancelRequested = false;
let activeJobPromise = null;

function getActiveFetchHeaders(uuid) {
  return {
    Accept: "application/json",
    "X-Own-Request": "true",
    Referer: `https://claude.ai/chat/${uuid}`,
    "anthropic-client-platform": "web_claude_ai",
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "downloadArtifacts") {
    handleDownloadArtifacts(request, sender)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "listConversations") {
    handleListConversations(request, sender)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "startExportJob") {
    handleStartExportJob(request, sender)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "getExportJobStatus") {
    getExportJob()
      .then((job) => sendResponse({ success: true, job }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "cancelExportJob") {
    jobCancelRequested = true;
    getExportJob().then((job) => {
      if (job?.status === "running") {
        setExportJob({ ...job, status: "cancelling" });
      }
    });
    sendResponse({ success: true });
    return false;
  }

  if (request.action === "cacheVisibleThinking") {
    handleCacheVisibleThinking(request)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

function getTabId(sender, request) {
  return request.tabId ?? sender.tab?.id;
}

async function findClaudeTab(preferredTabId) {
  if (preferredTabId) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (CLAUDE_URL_PATTERN.test(tab.url || "")) {
        return tab.id;
      }
    } catch {
      // ignore
    }
  }

  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  if (!tabs.length) {
    return null;
  }

  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const active = tabs.find((t) => t.active);
  return active?.id ?? tabs[0]?.id ?? null;
}

const CLAUDE_TAB_CONNECT_ERROR =
  "Could not connect to Claude tab. Refresh claude.ai and try again.";

async function pingContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "ping" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

async function ensureContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!CLAUDE_URL_PATTERN.test(tab.url || "")) {
    throw new Error(`tab is not a Claude page: ${tab.url || "unknown"}`);
  }

  if (await pingContentScript(tabId)) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["banner.js", "lib/export-core.js", "content.js"],
  });
  await delay(100);

  if (!(await pingContentScript(tabId))) {
    throw new Error(CLAUDE_TAB_CONNECT_ERROR);
  }
}

function notifyTab(tabId, payload, options = {}) {
  if (!tabId) {
    return;
  }
  chrome.tabs.sendMessage(tabId, payload, () => {
    if (chrome.runtime.lastError && !options.silent) {
      console.warn(
        LOG_PREFIX,
        "Could not notify tab:",
        chrome.runtime.lastError.message,
      );
    }
  });
}

function broadcastExportProgress(job) {
  chrome.runtime
    .sendMessage({ action: "exportProgress", job })
    .catch(() => {});
}

function getStoragePayload(uuid) {
  return new Promise((resolve) => {
    chrome.storage.local.get([`chat_${uuid}`], (result) => {
      resolve(result[`chat_${uuid}`]);
    });
  });
}

function getChatFetchMeta(uuid) {
  return new Promise((resolve) => {
    chrome.storage.local.get([`chat_meta_${uuid}`], (result) => {
      resolve(result[`chat_meta_${uuid}`]);
    });
  });
}

function storeChatFetchMeta(uuid, rawUrl) {
  const orgId = extractOrgIdFromPath(new URL(rawUrl).pathname);
  const updates = {
    [`chat_meta_${uuid}`]: { rawUrl, capturedAt: Date.now() },
  };
  if (orgId) {
    updates.last_org_id = orgId;
  }
  chrome.storage.local.set(updates);
}

function extractOrgIdFromPath(pathname) {
  const match = pathname.match(/\/organizations\/([0-9a-f-]{36})/i);
  return match ? match[1] : null;
}

function getLastOrgId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["last_org_id"], (result) => {
      resolve(result.last_org_id ?? null);
    });
  });
}

function getExportJob() {
  return new Promise((resolve) => {
    chrome.storage.local.get([EXPORT_JOB_KEY], (result) => {
      resolve(result[EXPORT_JOB_KEY] ?? null);
    });
  });
}

function setExportJob(job) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [EXPORT_JOB_KEY]: job }, resolve);
  });
}

async function storeChatPayload(resp) {
  const payload = normalizeChatPayload(resp) || resp;
  await new Promise((resolve) => {
    chrome.storage.local.set({ [`chat_${payload.uuid}`]: payload }, resolve);
  });
}

function buildConversationUrls(host, orgId, uuid) {
  return CONVERSATION_PARAM_SETS.map((params) => {
    const url = new URL(
      `/api/organizations/${orgId}/chat_conversations/${uuid}`,
      host,
    );
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  });
}

function parseChatConversationRequest(obj) {
  if (obj.method !== "GET") {
    return null;
  }
  try {
    const url = new URL(obj.url);
    if (url.hostname !== "api.claude.ai" && url.hostname !== "claude.ai") {
      return null;
    }
    if (!url.pathname.includes("chat_conversations")) {
      return null;
    }
    const uuidMatch = url.pathname.match(
      /\/chat_conversations\/([0-9a-f-]{36})\/?$/i,
    );
    if (!uuidMatch) {
      return null;
    }
    return {
      url,
      uuid: uuidMatch[1],
      renderingMode: url.searchParams.get("rendering_mode"),
    };
  } catch {
    return null;
  }
}

function buildRawConversationUrl(urlString) {
  const url = new URL(urlString);
  url.searchParams.set("tree", "True");
  url.searchParams.set("rendering_mode", "raw");
  return url.toString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_EXPORT_INCLUDES = {
  transcript: true,
  artifacts: true,
  pasted: true,
  thinking: true,
};

function normalizeExportIncludes(includes) {
  const src = includes || {};
  return {
    transcript: src.transcript !== false,
    artifacts: src.artifacts !== false,
    pasted: src.pasted !== false,
    thinking: src.thinking !== false,
  };
}

function hasAnyExportInclude(includes) {
  return (
    includes.transcript ||
    includes.artifacts ||
    includes.pasted ||
    includes.thinking
  );
}

function resolveExportIncludes(request) {
  if (request.exportIncludes) {
    return normalizeExportIncludes(request.exportIncludes);
  }

  const filter = request.contentFilter;
  if (filter === "artifacts") {
    return { transcript: false, artifacts: true, pasted: false };
  }
  if (filter === "pasted") {
    return { transcript: false, artifacts: false, pasted: true };
  }
  if (filter === "attachments") {
    return { transcript: true, artifacts: false, pasted: false };
  }

  return { ...DEFAULT_EXPORT_INCLUDES };
}

function createChatSkipRecord(chatUuid, chatName, reason) {
  return {
    type: "chat",
    chatUuid,
    chatName,
    label: chatName,
    reason,
  };
}

function createCategorySkipRecord(payload, type, reason) {
  const labels = {
    transcript: "Transcript",
    artifacts: "Artifacts",
    pasted: "Pasted",
    thinking: "Visible thinking",
  };
  return {
    type,
    chatUuid: payload.uuid,
    chatName: payload.name || "Untitled",
    label: labels[type] || type,
    reason,
  };
}

function formatFolderSkipReportText(skipped) {
  return skipped.map((skip) => `${skip.label} — ${skip.reason}`).join("\n");
}

function formatSkipReportText(skipped) {
  return skipped
    .map((skip) => {
      if (skip.type === "chat") {
        return `Chat: ${skip.chatName}\nReason: ${skip.reason}`;
      }
      return `[${skip.chatName}] ${skip.label} — ${skip.reason}`;
    })
    .join("\n\n---\n\n");
}

function summarizeFetchError(errors) {
  const fragments = errors
    .filter(Boolean)
    .join("; ")
    .split("; ")
    .map((part) => part.trim())
    .filter(Boolean);

  if (fragments.some((part) => part.includes("unusable payload"))) {
    return "Conversation has no messages or could not be loaded";
  }

  const httpFragment = fragments.find((part) => /HTTP \d{3}/.test(part));
  if (httpFragment) {
    const status = httpFragment.match(/HTTP (\d{3})/)?.[1];
    if (status === "403") {
      return "Access denied (HTTP 403)";
    }
    if (status === "404") {
      return "Conversation not found (HTTP 404)";
    }
    return `HTTP ${status} while fetching conversation`;
  }

  if (
    fragments.some(
      (part) =>
        part.includes("HTTP or network error") ||
        part.toLowerCase().includes("network error"),
    )
  ) {
    return "Network error while fetching conversation";
  }

  if (fragments.some((part) => part.includes("no chat-capable organizations"))) {
    return "Could not find a chat-capable organization";
  }

  if (fragments.some((part) => part.includes("timed out"))) {
    return "Fetch timed out";
  }

  return "Could not fetch conversation";
}

function getChatLevelSkips(skipped) {
  return skipped.filter((skip) => skip.type === "chat");
}

function formatSkipSummary(chatCount, totalFiles, skipped) {
  const header = `${chatCount} chat${chatCount === 1 ? "" : "s"}, ${totalFiles} file${totalFiles === 1 ? "" : "s"} exported.`;
  if (!skipped.length) {
    return header;
  }
  if (totalFiles === 0) {
    return "Nothing exported. Skipped items are described in export-skipped.txt.";
  }
  return `${header} Skipped items are described in the export.`;
}

function isTrivialTranscript(markdown, chatName) {
  const stripped = markdown.trim();
  const headerOnly = `# ${chatName}`.trim();
  return (
    !stripped ||
    stripped === headerOnly ||
    stripped === `${headerOnly}\n` ||
    stripped.replace(/\s/g, "") === headerOnly.replace(/\s/g, "")
  );
}

function showExportNotification(message) {
  if (!chrome.notifications?.create) {
    return;
  }

  const shortMessage = message.split("\n")[0];

  const iconUrl = chrome.runtime.getURL("icon48.png");

  chrome.notifications.create(
    `export-${Date.now()}`,
    {
      type: "basic",
      iconUrl,
      title: "Claude export complete",
      message: shortMessage,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn(
          LOG_PREFIX,
          "Notification skipped:",
          chrome.runtime.lastError.message,
        );
      }
    },
  );
}

function buildChatFolderPrefix(payload) {
  const normalized = normalizeChatPayload(payload) || payload;
  const shortId = normalized.uuid.slice(0, 8);
  return `${sanitizeFilename(normalized.name || "chat")}_${shortId}/`;
}

function buildChatMarkdown(payload) {
  const normalized = normalizeChatPayload(payload) || payload;
  const messages = getActiveBranchMessages(normalized);
  const lines = [`# ${normalized.name || "Untitled Chat"}`, ""];

  for (const message of messages) {
    const sender = message.sender === "human" ? "Human" : "Assistant";
    const timestamp = message.created_at
      ? new Date(message.created_at).toLocaleString()
      : "";
    lines.push(`### ${sender}${timestamp ? ` — ${timestamp}` : ""}`, "");

    const text = stripArtifactsFromText(getMessageText(message));
    if (text) {
      lines.push(text, "");
    }

    for (const att of getAttachmentExcerpts(message)) {
      lines.push(`> **Attachment: ${att.name}**`, "");
      for (const line of att.content.split("\n")) {
        lines.push(`> ${line}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

function domBlockToThinkingItem(block, capturedAt) {
  const partial = block.streaming === true;
  return {
    source: "dom",
    kind: block.kind || "status",
    title: block.title || "Visible status",
    content: block.content || "",
    partial,
    streaming: partial,
    expanded: block.expanded,
    collapsed: block.collapsed,
    turnIndex: block.turnIndex,
    blockIndex: block.blockIndex,
    capturedAt:
      partial && capturedAt
        ? new Date(capturedAt).toISOString()
        : partial
          ? new Date().toISOString()
          : undefined,
  };
}

async function getVisibleThinkingForChat(uuid) {
  const result = await chrome.storage.local.get([`visible_thinking_${uuid}`]);
  const entry = result[`visible_thinking_${uuid}`];
  if (!entry) {
    return { blocks: [], updatedAt: null };
  }
  return {
    blocks: entry.blocks || [],
    updatedAt: entry.updatedAt || null,
  };
}

function getUuidFromTabUrl(url) {
  return url?.match(/\/chat\/([0-9a-f-]{36})/i)?.[1] || null;
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || {});
    });
  });
}

function waitForTabChatPage(tabId, uuid, timeoutMs = DOM_SCRAPE_TIMEOUT_MS) {
  const chatPattern = new RegExp(
    `/chat/${uuid.replace(/-/g, "\\-")}`,
    "i",
  );

  return new Promise((resolve, reject) => {
    let settled = false;

    function finish(fn, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      fn(value);
    }

    const timeout = setTimeout(() => {
      finish(reject, new Error(`Timed out waiting for chat page ${uuid}`));
    }, timeoutMs);

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }
      if (chatPattern.test(tab.url || "")) {
        finish(resolve, tab);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.get(tabId).then((tab) => {
      if (chatPattern.test(tab.url || "") && tab.status === "complete") {
        finish(resolve, tab);
      }
    });
  });
}

async function waitForChatDomReady(tabId, uuid) {
  const deadline = Date.now() + DOM_SCRAPE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (jobCancelRequested) {
      return { ready: false, cancelled: true };
    }

    const probe = await sendTabMessage(tabId, {
      action: "probeChatDom",
      uuid,
    });

    if (probe.error) {
      await ensureContentScript(tabId);
      await delay(DOM_SCRAPE_POLL_MS);
      continue;
    }

    if (probe.ready) {
      return probe;
    }

    await delay(DOM_SCRAPE_POLL_MS);
  }

  return { ready: false, timedOut: true };
}

async function visitChatAndScrapeDomThinking(tabId, uuid) {
  if (!tabId || !uuid) {
    return [];
  }

  const chatUrl = `https://claude.ai/chat/${uuid}`;
  const tab = await chrome.tabs.get(tabId);
  const alreadyOnChat = getUuidFromTabUrl(tab.url) === uuid;

  if (!alreadyOnChat) {
    console.log(LOG_PREFIX, "visiting chat for DOM scrape:", uuid);
    await chrome.tabs.update(tabId, { url: chatUrl });
    await waitForTabChatPage(tabId, uuid);
  }

  await ensureContentScript(tabId);
  await delay(DOM_SCRAPE_RENDER_DELAY_MS);

  const probe = await waitForChatDomReady(tabId, uuid);
  console.log(LOG_PREFIX, "DOM probe for", uuid, probe);

  const scrapeResult = await sendTabMessage(tabId, {
    action: "scrapeVisibleThinking",
    uuid,
    expandPanels: true,
    expandDelayMs: DOM_SCRAPE_EXPAND_DELAY_MS,
  });

  if (scrapeResult.error) {
    console.warn(
      LOG_PREFIX,
      "DOM scrape message failed for",
      uuid,
      scrapeResult.error,
    );
    return [];
  }

  const blocks = scrapeResult.blocks || [];
  if (blocks.length) {
    await handleCacheVisibleThinking({
      uuid,
      blocks,
      updatedAt: Date.now(),
    });
    console.log(
      LOG_PREFIX,
      "cached",
      blocks.length,
      "status/thinking blocks from DOM visit for",
      uuid,
    );
  }

  return blocks;
}

async function getVisibleThinkingFromTab(tabId, uuid) {
  if (!tabId || !uuid) {
    return [];
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!CHAT_URL_PATTERN.test(tab.url || "")) {
      return [];
    }
    if (getUuidFromTabUrl(tab.url) !== uuid) {
      return [];
    }
    const response = await sendTabMessage(tabId, {
      action: "getVisibleThinking",
      uuid,
    });
    return response?.blocks || [];
  } catch {
    return [];
  }
}

async function collectThinkingForChat(payload, tabId, uuid, options = {}) {
  const { visitForDom = false } = options;
  const byKey = new Map();
  const chatUuid = uuid || payload.uuid;

  if (visitForDom && tabId && chatUuid) {
    try {
      await visitChatAndScrapeDomThinking(tabId, chatUuid);
    } catch (error) {
      console.warn(
        LOG_PREFIX,
        "DOM visit scrape failed for",
        chatUuid,
        error.message,
      );
    }
  }

  for (const item of collectThinkingFromPayload(payload)) {
    byKey.set(thinkingDedupeKey(item), item);
  }

  const cachedDom = await getVisibleThinkingForChat(chatUuid);
  for (const block of cachedDom.blocks) {
    const item = domBlockToThinkingItem(block, cachedDom.updatedAt);
    const key = thinkingDedupeKey(item);
    if (!byKey.has(key)) {
      byKey.set(key, item);
    }
  }

  const liveDom = await getVisibleThinkingFromTab(tabId, chatUuid);
  for (const block of liveDom) {
    const item = domBlockToThinkingItem(block);
    const key = thinkingDedupeKey(item);
    if (!byKey.has(key)) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()];
}

async function handleCacheVisibleThinking(request) {
  if (!request.uuid || !Array.isArray(request.blocks)) {
    return { ok: false };
  }

  await chrome.storage.local.set({
    [`visible_thinking_${request.uuid}`]: {
      uuid: request.uuid,
      blocks: request.blocks,
      updatedAt: request.updatedAt || Date.now(),
    },
  });

  return { ok: true };
}

function writeThinkingToZip(zip, folderPrefix, thinkingItems) {
  if (!thinkingItems.length) {
    return 0;
  }

  let count = 0;
  const indexEntries = [];

  for (const item of thinkingItems) {
    count += 1;

    const base = sanitizeFilename(
      `${String(count).padStart(4, "0")}_${item.title || "visible_thinking"}`,
    );
    const suffix = item.partial ? "_partial" : "";
    const filename = `${folderPrefix}thinking/${base}${suffix}.md`;

    const frontmatter = [
      "---",
      `source: ${item.source || "payload"}`,
      `kind: ${item.kind || "thinking"}`,
      `partial: ${item.partial ? "true" : "false"}`,
      `streaming: ${item.streaming ? "true" : "false"}`,
    ];
    if (item.expanded != null) {
      frontmatter.push(`expanded: ${item.expanded ? "true" : "false"}`);
    }
    if (item.collapsed != null) {
      frontmatter.push(`collapsed: ${item.collapsed ? "true" : "false"}`);
    }
    if (item.signature) {
      frontmatter.push(`signature: ${item.signature}`);
    }
    if (item.partial && item.capturedAt) {
      frontmatter.push(`captured_at: ${item.capturedAt}`);
    }
    frontmatter.push("---");

    zip.file(
      filename,
      [
        ...frontmatter,
        "",
        `# ${item.title || "Visible thinking"}`,
        "",
        item.content || "",
        "",
      ].join("\n"),
    );

    indexEntries.push({
      filename: `${base}${suffix}.md`,
      title: item.title,
      source: item.source,
      kind: item.kind,
      partial: !!item.partial,
    });
  }

  zip.file(
    `${folderPrefix}thinking/thinking_index.json`,
    JSON.stringify(indexEntries, null, 2),
  );

  return count;
}

function writeFileCategoryToZip(zip, folderPrefix, subfolder, items) {
  if (!items.length) {
    return Promise.resolve({ fileCount: 0, indexEntries: [] });
  }

  const CLAUDE_DOWNLOAD_DOMAINS = new Set([
    "claude.ai",
    "api.claude.ai",
  ]);

  function isClaudeSafeUrl(url) {
    try {
      const parsed = new URL(url);
      return CLAUDE_DOWNLOAD_DOMAINS.has(parsed.hostname);
    } catch {
      return false;
    }
  }

  const BINARY_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
    ".pdf", ".zip", ".gz", ".tar",
    ".mp4", ".mov", ".webm", ".mp3", ".wav", ".ogg",
    ".ico", ".bmp", ".tiff", ".svg",
  ]);

  const usedNames = new Set();

  async function processItem(item) {
    const fileId = item.fileId || null;
    const mimeType = item.mimeType || null;
    const size = item.size ?? null;
    const urls = item.urls || [];
    const metadataOnly = !!item.metadataOnly;

    let exportKind = "text";
    let downloadAttempted = false;
    let downloadSucceeded = false;
    let fallbackReason = null;
    let fileContent = item.content;
    let itemLanguage = item.language;

    // Determine extension for naming
    const inferredExt = CadExportCore.getFileExtension(itemLanguage);
    const titleAlreadyHasExt = CadExportCore.titleHasExtension(item.title, inferredExt);

    // For metadata-only items with URLs, attempt binary download
    if (metadataOnly && urls.length > 0) {
      const safeUrls = urls.filter(isClaudeSafeUrl);
      for (const url of safeUrls) {
        downloadAttempted = true;
        try {
          const response = await fetch(url, {
            credentials: "include",
            headers: { Accept: "*/*" },
          });
          if (response.ok) {
            const blob = await response.arrayBuffer();
            if (blob.byteLength > 0) {
              // Determine binary filename
              const binaryExt = mimeType
                ? CadExportCore.getFileExtension(mimeType)
                : inferredExt;
              const baseName = sanitizeFilename(item.title).replace(/[^\w\-._]+/g, "_");
              const alreadyHasBinaryExt = CadExportCore.titleHasExtension(item.title, binaryExt);
              const ext = alreadyHasBinaryExt ? "" : binaryExt;
              let fileName = `${(item.messageIndex ?? 0) + 1}_${baseName}${ext}`;
              if (usedNames.has(fileName)) {
                let suffix = 1;
                while (usedNames.has(fileName)) {
                  fileName = `${(item.messageIndex ?? 0) + 1}_${baseName}_${suffix}${ext}`;
                  suffix++;
                }
              }
              usedNames.add(fileName);

              zip.file(`${folderPrefix}${subfolder}/${fileName}`, blob);
              exportKind = "binary";
              downloadSucceeded = true;

              return {
                fileCount: 1,
                indexEntry: {
                  path: `${subfolder}/${fileName}`,
                  title: item.title,
                  source: item.source || null,
                  category: item.category || subfolder,
                  messageIndex: item.messageIndex ?? null,
                  exportKind,
                  fileId,
                  mimeType,
                  size,
                  urlCount: urls.length,
                  downloadAttempted,
                  downloadSucceeded,
                  metadataOnly,
                },
              };
            }
          }
          fallbackReason = `HTTP ${response.status}`;
        } catch (err) {
          fallbackReason = err.message || "download failed";
        }
      }
      if (!downloadSucceeded && safeUrls.length === 0 && urls.length > 0) {
        fallbackReason = "no Claude-domain URLs";
      }
    }

    if (metadataOnly) {
      exportKind = "metadata";
    }

    // Write text or metadata markdown
    const fileName = getUniqueFileName(
      item.title,
      metadataOnly ? "markdown" : item.language,
      item.messageIndex ?? 0,
      usedNames,
    );
    zip.file(`${folderPrefix}${subfolder}/${fileName}`, fileContent);

    return {
      fileCount: 1,
      indexEntry: {
        path: `${subfolder}/${fileName}`,
        title: item.title,
        source: item.source || null,
        category: item.category || subfolder,
        messageIndex: item.messageIndex ?? null,
        exportKind,
        fileId,
        mimeType,
        size,
        urlCount: urls.length,
        downloadAttempted,
        downloadSucceeded,
        fallbackReason,
        metadataOnly,
      },
    };
  }

  return (async () => {
    let fileCount = 0;
    const indexEntries = [];

    for (const item of items) {
      const result = await processItem(item);
      fileCount += result.fileCount;
      indexEntries.push(result.indexEntry);
    }

    return { fileCount, indexEntries };
  })();
}

async function writeStructuredChatToZip(
  zip,
  payload,
  exportIncludes,
  folderPrefix,
  thinkingItems = [],
) {
  let fileCount = 0;
  const skipped = [];
  const normalized = normalizeChatPayload(payload) || payload;
  const chatName = normalized.name || "Untitled";
  const messages = getActiveBranchMessages(normalized);
  const { artifacts, attachments, presentedFiles, generatedFiles, pasted } =
    collectCategorizedItemsFromPayload(normalized);
  const allFileItems = [
    ...artifacts,
    ...attachments,
    ...presentedFiles,
    ...generatedFiles,
  ];

  if (exportIncludes.transcript) {
    if (messages.length === 0) {
      skipped.push(
        createCategorySkipRecord(
          normalized,
          "transcript",
          "No messages on active branch",
        ),
      );
    } else {
      const markdown = buildChatMarkdown(normalized);
      if (isTrivialTranscript(markdown, chatName)) {
        skipped.push(
          createCategorySkipRecord(normalized, "transcript", "Transcript content is empty"),
        );
      } else {
        zip.file(`${folderPrefix}chat.md`, markdown);
        fileCount++;
      }
    }
  }

  if (exportIncludes.artifacts) {
    const filesIndex = [];
    const categoryWrites = [
      ["artifacts", artifacts],
      ["attachments", attachments],
      ["presented-files", presentedFiles],
      ["generated-files", generatedFiles],
    ];

    for (const [subfolder, items] of categoryWrites) {
      const result = await writeFileCategoryToZip(
        zip,
        folderPrefix,
        subfolder,
        items,
      );
      fileCount += result.fileCount;
      filesIndex.push(...result.indexEntries);
    }

    if (allFileItems.length === 0) {
      skipped.push(
        createCategorySkipRecord(
          normalized,
          "artifacts",
          "No artifacts or exportable files found",
        ),
      );
    } else if (filesIndex.length) {
      zip.file(
        `${folderPrefix}files_index.json`,
        JSON.stringify(filesIndex, null, 2),
      );
      fileCount++;
    }
  }

  if (exportIncludes.pasted) {
    if (pasted.length === 0) {
      skipped.push(
        createCategorySkipRecord(
          normalized,
          "pasted",
          "No pasted messages over 80 characters",
        ),
      );
    } else {
      const usedNames = new Set();
      for (const item of pasted) {
        const fileName = getUniqueFileName(
          item.title,
          item.language,
          item.messageIndex,
          usedNames,
        );
        zip.file(`${folderPrefix}pasted/${fileName}`, item.content);
        fileCount++;
      }
    }
  }

  if (exportIncludes.thinking) {
    if (thinkingItems.length === 0) {
      skipped.push(
        createCategorySkipRecord(
          normalized,
          "thinking",
          "No visible thinking/status panels found",
        ),
      );
    } else {
      fileCount += writeThinkingToZip(zip, folderPrefix, thinkingItems);
    }
  }

  if (skipped.length > 0) {
    zip.file(
      `${folderPrefix}skipped.txt`,
      formatFolderSkipReportText(skipped),
    );
    fileCount++;
  }

  return { fileCount, skipped };
}

async function addChatToZip(zip, payload, options) {
  const {
    exportIncludes,
    tabId,
    uuid,
    tryRawSupplement = false,
    visitForDom = false,
  } = options;
  const normalized = normalizeChatPayload(payload) || payload;
  const folderPrefix = buildChatFolderPrefix(normalized);

  let thinkingItems = [];
  if (exportIncludes.thinking) {
    thinkingItems = await collectThinkingForChat(normalized, tabId, uuid, {
      visitForDom,
    });
  }

  const cachedDom = await getVisibleThinkingForChat(uuid || normalized.uuid);
  logExportDiagnostics(normalized, {
    domBlocks: cachedDom.blocks || thinkingItems.filter((item) => item.source === "dom"),
    debug: true,
  });

  let result = await writeStructuredChatToZip(
    zip,
    normalized,
    exportIncludes,
    folderPrefix,
    thinkingItems,
  );

  if (result.fileCount === 0 && tryRawSupplement && tabId && uuid) {
    const rawSupplement = await fetchPayloadViaPageEventBridge(tabId, uuid, {
      rawOnly: true,
    });
    if (rawSupplement.payload) {
      if (exportIncludes.thinking) {
        thinkingItems = await collectThinkingForChat(
          rawSupplement.payload,
          tabId,
          uuid,
          { visitForDom: false },
        );
      }
      result = await writeStructuredChatToZip(
        zip,
        rawSupplement.payload,
        exportIncludes,
        folderPrefix,
        thinkingItems,
      );
      if (result.fileCount > 0) {
        await storeChatPayload(rawSupplement.payload);
      }
    }
  }

  return result;
}

async function downloadZip(zip, filename) {
  const base64 = await zip.generateAsync({ type: "base64" });
  const url = `data:application/zip;base64,${base64}`;

  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: true,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      },
    );
  });
}

// ── Combined context file generation ────────────────────────────────

const COMBINED_FILENAME = "_combined.txt";
const COMBINED_DEDUPED_FILENAME = "_combined_deduped.txt";
const COMBINED_FILENAMES = new Set([COMBINED_FILENAME, COMBINED_DEDUPED_FILENAME]);
const COMBINED_SEPARATOR = "─".repeat(52);
const COMBINED_TOP = "┌" + "─".repeat(52);
const COMBINED_BOT = "└" + "─".repeat(52);

function collectZipTextFiles(zip, folderPath) {
  const BINARY_SKIP_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
    ".pdf", ".zip", ".gz", ".tar",
    ".mp4", ".mov", ".webm", ".mp3", ".wav", ".ogg",
    ".ico", ".bmp", ".tiff", ".svg",
  ]);

  const prefix = folderPath ? (folderPath.endsWith("/") ? folderPath : folderPath + "/") : "";
  const files = [];

  zip.forEach((relativePath, entry) => {
    if (entry.dir) {
      return;
    }
    if (!relativePath.startsWith(prefix)) {
      return;
    }
    const name = relativePath.slice(prefix.length);
    if (COMBINED_FILENAMES.has(name.split("/").pop())) {
      return;
    }
    if (name.endsWith(".json")) {
      return;
    }
    // Skip binary files from combined text
    const extMatch = name.match(/\.[^./]+$/);
    if (extMatch && BINARY_SKIP_EXTENSIONS.has(extMatch[0].toLowerCase())) {
      return;
    }
    files.push({ path: relativePath, localPath: name });
  });

  files.sort((a, b) => a.localPath.localeCompare(b.localPath));
  return files;
}

function getZipSubfolders(zip, folderPath) {
  const prefix = folderPath ? (folderPath.endsWith("/") ? folderPath : folderPath + "/") : "";
  const folders = new Set();

  zip.forEach((relativePath, entry) => {
    if (!relativePath.startsWith(prefix)) {
      return;
    }
    const rest = relativePath.slice(prefix.length);
    const slashIndex = rest.indexOf("/");
    if (slashIndex > 0) {
      folders.add(rest.slice(0, slashIndex));
    }
  });

  return [...folders].sort();
}

function groupFilesByFolder(files) {
  const groups = new Map();
  for (const file of files) {
    const slashIndex = file.localPath.indexOf("/");
    const folder = slashIndex > 0 ? file.localPath.slice(0, slashIndex) : "";
    if (!groups.has(folder)) {
      groups.set(folder, []);
    }
    groups.get(folder).push(file);
  }
  return groups;
}

async function buildCombinedText(zip, folderPath) {
  const files = collectZipTextFiles(zip, folderPath);
  if (files.length === 0) {
    return null;
  }

  const lines = [];
  const grouped = groupFilesByFolder(files);
  let isFirst = true;

  for (const [folder, folderFiles] of grouped) {
    if (folder) {
      if (!isFirst) {
        lines.push("", "");
      }
      lines.push(COMBINED_TOP);
      lines.push(`│ 📁 ${folder}/`);
      lines.push(COMBINED_BOT);
      lines.push("");
    }

    for (const file of folderFiles) {
      if (!isFirst && !folder) {
        lines.push("", COMBINED_SEPARATOR, "");
      }
      isFirst = false;

      const displayName = file.localPath;
      lines.push(`┌ 📄 ${displayName}`);
      lines.push(COMBINED_BOT);

      try {
        const content = await zip.file(file.path).async("string");
        if (content.trim()) {
          lines.push(content.trimEnd());
        }
      } catch {
        lines.push("[Could not read file]");
      }

      lines.push("");
    }
  }

  const prefix = folderPath ? folderPath.replace(/\/$/, "").split("/").pop() : "export";
  lines.push(COMBINED_SEPARATOR);
  lines.push(`${files.length} file${files.length === 1 ? "" : "s"} combined from ${prefix}/`);
  lines.push("");

  return lines.join("\n");
}

function normParagraph(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function splitParagraphs(content) {
  if (!content) {
    return [];
  }
  return content.split(/\n\s*\n/).filter((block) => block.trim());
}

function formatPid(pid, width) {
  return `P${String(pid).padStart(width, "0")}`;
}

async function buildCombinedDeduped(zip, folderPath) {
  const files = collectZipTextFiles(zip, folderPath);
  if (files.length === 0) {
    return null;
  }

  const paragraphs = [];
  let pid = 1;

  for (const file of files) {
    let content;
    try {
      content = await zip.file(file.path).async("string");
    } catch {
      content = "";
    }
    for (const block of splitParagraphs(content)) {
      paragraphs.push({
        pid: pid++,
        sourceFile: file.localPath,
        text: block,
        normKey: normParagraph(block),
      });
    }
  }

  if (paragraphs.length === 0) {
    return null;
  }

  const width = Math.max(4, String(paragraphs.length).length);
  const seen = new Map();
  const canonicalFor = new Map();

  for (const para of paragraphs) {
    if (!para.normKey) {
      canonicalFor.set(para.pid, para.pid);
      continue;
    }
    if (!seen.has(para.normKey)) {
      seen.set(para.normKey, para.pid);
      canonicalFor.set(para.pid, para.pid);
    } else {
      canonicalFor.set(para.pid, seen.get(para.normKey));
    }
  }

  const lines = [
    "# Combined & Deduplicated Context",
    `# [P${"#".repeat(width)}] IDs identify each paragraph.`,
    `# "→ P${"#".repeat(width)}" means duplicate removed — see referenced paragraph for full text.`,
    "",
  ];

  const paraByFile = new Map();
  for (const para of paragraphs) {
    if (!paraByFile.has(para.sourceFile)) {
      paraByFile.set(para.sourceFile, []);
    }
    paraByFile.get(para.sourceFile).push(para);
  }

  for (const file of files) {
    lines.push(`┌ 📄 ${file.localPath}`);
    lines.push(COMBINED_BOT);
    lines.push("");

    const fileParagraphs = paraByFile.get(file.localPath) || [];
    for (const para of fileParagraphs) {
      const keptPid = canonicalFor.get(para.pid);
      if (keptPid === para.pid) {
        lines.push(`[${formatPid(para.pid, width)}]`);
        if (para.text) {
          lines.push(para.text);
        }
      } else {
        lines.push(`[${formatPid(para.pid, width)}]`);
        lines.push(`→ ${formatPid(keptPid, width)}`);
      }
      lines.push("");
    }
  }

  const uniqueNorm = new Set(
    paragraphs.filter((p) => p.normKey).map((p) => p.normKey),
  ).size;
  const removed = paragraphs.length - uniqueNorm;

  lines.push(COMBINED_SEPARATOR);
  lines.push("STATS");
  lines.push(`  files: ${files.length}`);
  lines.push(`  paragraphs_total: ${paragraphs.length}`);
  lines.push(`  paragraphs_unique: ${uniqueNorm}`);
  lines.push(`  duplicates_removed: ${removed}`);
  lines.push("");

  return lines.join("\n");
}

async function writeCombinedFilesForFolder(zip, folderPath) {
  const prefix = folderPath
    ? folderPath.endsWith("/") ? folderPath : folderPath + "/"
    : "";

  const textFiles = collectZipTextFiles(zip, folderPath);
  if (textFiles.length <= 1) {
    return 0;
  }

  let count = 0;

  const combined = await buildCombinedText(zip, folderPath);
  if (combined) {
    zip.file(`${prefix}${COMBINED_FILENAME}`, combined);
    count++;
  }

  const deduped = await buildCombinedDeduped(zip, folderPath);
  if (deduped) {
    zip.file(`${prefix}${COMBINED_DEDUPED_FILENAME}`, deduped);
    count++;
  }

  return count;
}

async function writeCombinedFilesRecursive(zip) {
  const topFolders = getZipSubfolders(zip, "");
  let totalCombinedFiles = 0;

  for (const topFolder of topFolders) {
    const subfolders = getZipSubfolders(zip, topFolder);
    for (const subfolder of subfolders) {
      const subPath = `${topFolder}/${subfolder}`;
      totalCombinedFiles += await writeCombinedFilesForFolder(zip, subPath);
    }

    totalCombinedFiles += await writeCombinedFilesForFolder(zip, topFolder);
  }

  totalCombinedFiles += await writeCombinedFilesForFolder(zip, "");

  return totalCombinedFiles;
}

// ── End combined context file generation ────────────────────────────

async function updateJobProgress(partial, tabId) {
  const current = (await getExportJob()) || {};
  const job = { ...current, ...partial };
  await setExportJob(job);
  broadcastExportProgress(job);
  if (tabId) {
    notifyTab(tabId, { action: "exportProgress", job }, { silent: true });
  }
  return job;
}

function buildConversationNameMap(conversations) {
  const nameByUuid = new Map();
  for (const conv of conversations) {
    if (conv?.uuid) {
      nameByUuid.set(conv.uuid, conv.name || "Untitled");
    }
  }
  return nameByUuid;
}

async function resolveChatDisplayName(uuid, payload, nameByUuid) {
  if (payload?.name) {
    return payload.name;
  }
  if (nameByUuid.has(uuid)) {
    return nameByUuid.get(uuid);
  }
  const cached = await getStoragePayload(uuid);
  if (cached?.name) {
    return cached.name;
  }
  return "Untitled";
}

async function resolveUuidList(request, tabId) {
  const scope = request.scope || "current";

  if (scope === "selected") {
    if (!request.uuids?.length) {
      throw new Error("No conversations selected.");
    }
    const list = await fetchAllConversations(tabId);
    return {
      uuids: request.uuids,
      nameByUuid: buildConversationNameMap(list),
    };
  }

  if (scope === "all") {
    const list = await fetchAllConversations(tabId);
    if (!list.length) {
      throw new Error("No conversations found.");
    }
    return {
      uuids: list.map((c) => c.uuid),
      nameByUuid: buildConversationNameMap(list),
    };
  }

  if (!request.uuid) {
    throw new Error("No conversation UUID found.");
  }
  return { uuids: [request.uuid], nameByUuid: new Map() };
}

async function runExportJob(request, tabId) {
  jobCancelRequested = false;
  const exportIncludes = resolveExportIncludes(request);
  if (!hasAnyExportInclude(exportIncludes)) {
    throw new Error("Select at least one content type to export.");
  }

  const job = {
    status: "running",
    phase: "listing",
    current: 0,
    total: 0,
    currentChatName: "",
    fileCount: 0,
    chatCount: 0,
    skipped: [],
    errors: [],
    startedAt: Date.now(),
    finishedAt: null,
    message: "",
  };
  await setExportJob(job);
  broadcastExportProgress(job);

  let originalTabUrl = null;
  let shouldRestoreTab = false;

  try {
    const { uuids, nameByUuid } = await resolveUuidList(request, tabId);
    const scope = request.scope || "current";
    const visitForDom =
      exportIncludes.thinking && tabId && scope !== "current";

    if (visitForDom) {
      shouldRestoreTab = true;
      try {
        const startTab = await chrome.tabs.get(tabId);
        originalTabUrl = startTab.url || null;
      } catch {
        originalTabUrl = null;
      }
    }

    await updateJobProgress(
      {
        phase: visitForDom ? "visiting chats" : "fetching",
        total: uuids.length,
        current: 0,
      },
      tabId,
    );

    const zip = new JSZip();
    let totalFiles = 0;
    let chatCount = 0;
    const skipped = [];

    for (let i = 0; i < uuids.length; i++) {
      if (jobCancelRequested) {
        break;
      }

      const uuid = uuids[i];
      const { payload, error: fetchError } = await ensureChatPayload(
        uuid,
        tabId,
      );

      const chatName = await resolveChatDisplayName(uuid, payload, nameByUuid);
      await updateJobProgress(
        {
          current: i + 1,
          currentChatName: chatName,
        },
        tabId,
      );

      if (!payload) {
        skipped.push(
          createChatSkipRecord(
            uuid,
            chatName,
            fetchError || "fetch failed",
          ),
        );
        await delay(CHAT_FETCH_DELAY_MS);
        continue;
      }

      const { fileCount, skipped: chatSkips } = await addChatToZip(zip, payload, {
        exportIncludes,
        tabId,
        uuid,
        tryRawSupplement: true,
        visitForDom,
      });

      skipped.push(...chatSkips);

      if (fileCount === 0) {
        const reason = !payload.chat_messages?.length
          ? "Conversation has no messages"
          : "No exportable content for selected options";
        skipped.push(
          createChatSkipRecord(uuid, payload.name || chatName, reason),
        );
      } else {
        totalFiles += fileCount;
        chatCount++;
      }

      await delay(CHAT_FETCH_DELAY_MS);
    }

    if (jobCancelRequested) {
      await updateJobProgress(
        {
          status: "cancelled",
          phase: "done",
          skipped,
          fileCount: totalFiles,
          chatCount,
          finishedAt: Date.now(),
          message: "Export cancelled.",
        },
        tabId,
      );
      return {
        cancelled: true,
        message: "Export cancelled.",
        artifactCount: totalFiles,
        chatCount,
        skipped,
      };
    }

    if (totalFiles === 0) {
      const msg = formatSkipSummary(0, 0, skipped);
      const chatSkips = getChatLevelSkips(skipped);

      if (chatSkips.length > 0) {
        await updateJobProgress({ phase: "zipping" }, tabId);
        const emptyZip = new JSZip();
        emptyZip.file("export-skipped.txt", formatSkipReportText(chatSkips));
        const date = new Date().toISOString().slice(0, 10);
        await updateJobProgress({ phase: "downloading" }, tabId);
        await downloadZip(emptyZip, `claude-export-${date}.zip`);
      }

      await updateJobProgress(
        {
          status: "done",
          phase: "done",
          skipped,
          skipSummary: msg,
          fileCount: 0,
          chatCount: 0,
          finishedAt: Date.now(),
          message: msg,
        },
        tabId,
      );
      notifyTab(tabId, {
        action: "artifactsProcessed",
        success: true,
        message: msg,
      });
      if (chatSkips.length > 0) {
        showExportNotification(msg);
      }
      return { message: msg, artifactCount: 0, chatCount: 0, skipped };
    }

    await updateJobProgress({ phase: "zipping" }, tabId);

    const combinedCount = await writeCombinedFilesRecursive(zip);
    totalFiles += combinedCount;

    const chatSkips = getChatLevelSkips(skipped);
    if (chatSkips.length > 0) {
      zip.file("export-skipped.txt", formatSkipReportText(chatSkips));
    }

    let filename;
    if (scope === "current" && uuids.length === 1) {
      const cached = await getStoragePayload(uuids[0]);
      filename = `${sanitizeFilename(cached?.name || "claude-export")}.zip`;
    } else {
      const date = new Date().toISOString().slice(0, 10);
      filename = `claude-export-${date}.zip`;
    }

    await updateJobProgress({ phase: "downloading" }, tabId);
    await downloadZip(zip, filename);

    const msg = formatSkipSummary(chatCount, totalFiles, skipped);
    await updateJobProgress(
      {
        status: "done",
        phase: "done",
        skipped,
        skipSummary: msg,
        fileCount: totalFiles,
        chatCount,
        finishedAt: Date.now(),
        message: msg,
      },
      tabId,
    );

    notifyTab(tabId, {
      action: "artifactsProcessed",
      success: true,
      message: msg,
    });

    showExportNotification(msg);

    return {
      message: msg,
      artifactCount: totalFiles,
      chatCount,
      skipped,
    };
  } catch (error) {
    console.error(LOG_PREFIX, "export job error:", error);
    await updateJobProgress(
      {
        status: "error",
        phase: "done",
        finishedAt: Date.now(),
        message: error.message,
        errors: [error.message],
      },
      tabId,
    );
    notifyTab(
      tabId,
      {
        action: "artifactsProcessed",
        failure: true,
        message: error.message,
      },
      { silent: true },
    );
    throw error;
  } finally {
    if (shouldRestoreTab && originalTabUrl && tabId) {
      try {
        await chrome.tabs.update(tabId, { url: originalTabUrl });
        console.log(LOG_PREFIX, "restored Claude tab URL after bulk export");
      } catch (error) {
        console.warn(
          LOG_PREFIX,
          "Could not restore Claude tab URL:",
          error.message,
        );
      }
    }
  }
}

async function handleStartExportJob(request, sender) {
  const existing = await getExportJob();
  if (existing?.status === "running") {
    throw new Error("An export is already in progress.");
  }

  const tabId = await findClaudeTab(getTabId(sender, request));
  if (!tabId) {
    throw new Error("Open claude.ai in a tab and try again.");
  }

  activeJobPromise = runExportJob(request, tabId).finally(() => {
    activeJobPromise = null;
  });

  return { started: true };
}

async function handleDownloadArtifacts(request, sender) {
  const tabId = await findClaudeTab(getTabId(sender, request));
  if (!tabId && !request.uuid) {
    const msg = "Open claude.ai in a tab and try again.";
    throw new Error(msg);
  }

  const exportRequest = {
    scope: "current",
    uuid: request.uuid,
    exportIncludes: resolveExportIncludes(request),
    tabId,
  };

  if (!exportRequest.uuid) {
    throw new Error("No conversation UUID found.");
  }

  console.log(LOG_PREFIX, "download requested for", exportRequest.uuid);
  return runExportJob(exportRequest, tabId);
}

async function handleListConversations(_request, sender) {
  const tabId = await findClaudeTab(getTabId(sender, _request));
  if (!tabId) {
    throw new Error("Open claude.ai in a tab and try again.");
  }

  const result = await fetchConversationListViaPageBridge(tabId, {
    fetchAll: true,
  });
  if (result.error && !result.conversations.length) {
    throw new Error(result.error);
  }

  return { conversations: result.conversations };
}

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  const url = changeInfo.url || tab?.url;
  if (
    changeInfo.status === "complete" &&
    url &&
    CHAT_URL_PATTERN.test(url)
  ) {
    chrome.tabs.sendMessage(
      tabId,
      { action: "checkAndAddDownloadButton" },
      () => {
        void chrome.runtime.lastError;
      },
    );
  }
});

const webRequestExtraInfoSpec = ["requestHeaders"];
if (chrome.webRequest.OnBeforeSendHeadersOptions?.EXTRA_HEADERS) {
  webRequestExtraInfoSpec.push("extraHeaders");
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (obj) => {
    const parsed = parseChatConversationRequest(obj);
    if (!parsed || isOwnRequest(obj)) {
      return;
    }

    console.log(LOG_PREFIX, "Saw chat-conversation API request:", obj.url, {
      uuid: parsed.uuid,
      rendering_mode: parsed.renderingMode,
    });

    const rawUrl = buildRawConversationUrl(obj.url);
    storeChatFetchMeta(parsed.uuid, rawUrl);

    const fetchUrl = parsed.renderingMode === "raw" ? obj.url : rawUrl;
    if (parsed.renderingMode !== "raw") {
      console.log(
        LOG_PREFIX,
        "No rendering_mode=raw; will try raw URL:",
        fetchUrl,
      );
    }

    console.log(
      LOG_PREFIX,
      "Decided to fetch/cache conversation:",
      parsed.uuid,
      fetchUrl,
    );

    fetchChat(fetchUrl, obj.method, obj.requestHeaders).then(async (resp) => {
      if (!resp) {
        console.warn(
          LOG_PREFIX,
          "fetchChat returned no payload for",
          fetchUrl,
        );
        return;
      }
      if (!isStorableChatPayload(resp)) {
        console.warn(LOG_PREFIX, "Unusable chat payload:", fetchUrl, resp);
        return;
      }
      const existing = await getStoragePayload(resp.uuid);
      if (isValidChatPayload(existing) && resp.chat_messages.length === 0) {
        return;
      }
      console.log(
        LOG_PREFIX,
        "Stored chat payload:",
        resp.uuid,
        `(${resp.chat_messages.length} messages)`,
      );
      await storeChatPayload(resp);
    });
  },
  {
    urls: [
      "https://api.claude.ai/api/*chat_conversations*",
      "https://claude.ai/api/*chat_conversations*",
    ],
  },
  webRequestExtraInfoSpec,
);

function isOwnRequest(obj) {
  return (
    obj.requestHeaders?.some((header) => header.name === "X-Own-Request") ??
    false
  );
}

async function fetchChat(url, method, requestHeaders, uuid) {
  const headers = uuid
    ? getActiveFetchHeaders(uuid)
    : { Accept: "application/json" };
  (requestHeaders ?? []).forEach(
    (header) => (headers[header.name] = header.value),
  );
  headers["X-Own-Request"] = "true";
  try {
    const response = await fetch(url, {
      method: method ?? "GET",
      headers,
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(LOG_PREFIX, "Fetch error:", error);
    return null;
  }
}

async function fetchPayloadFromUrl(url, requestHeaders, uuid) {
  const resp = await fetchChat(url, "GET", requestHeaders, uuid);
  if (!resp) {
    return { payload: null, error: `HTTP or network error for ${url}` };
  }
  if (!isStorableChatPayload(resp)) {
    return { payload: null, error: `unusable payload from ${url}` };
  }
  return { payload: normalizeChatPayload(resp) };
}

async function discoverOrganizationIds() {
  const orgIds = new Set();
  const lastOrgId = await getLastOrgId();
  if (lastOrgId) {
    orgIds.add(lastOrgId);
  }

  for (const orgUrl of ORG_API_URLS) {
    try {
      const response = await fetch(orgUrl, {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "X-Own-Request": "true",
        },
      });
      if (!response.ok) {
        continue;
      }
      const data = await response.json();
      for (const id of collectChatOrgIds(data)) {
        orgIds.add(id);
      }
    } catch (error) {
      console.warn(LOG_PREFIX, "Organization discovery error:", orgUrl, error);
    }
  }

  return [...orgIds];
}

async function fetchPayloadViaOrgDiscovery(uuid) {
  const orgIds = await discoverOrganizationIds();
  if (orgIds.length === 0) {
    return { payload: null, error: "no organizations discovered" };
  }

  const errors = [];
  for (const orgId of orgIds) {
    for (const host of API_HOSTS) {
      for (const url of buildConversationUrls(host, orgId, uuid)) {
        const result = await fetchPayloadFromUrl(url, null, uuid);
        if (result.payload) {
          storeChatFetchMeta(uuid, url);
          return result;
        }
        errors.push(result.error);
      }
    }
  }

  return {
    payload: null,
    error: errors.join("; ") || "org discovery fetch failed",
  };
}

function normalizeConversationSummary(conv) {
  return {
    uuid: conv.uuid,
    name: conv.name || "Untitled",
    updated_at: conv.updated_at || conv.created_at || null,
    created_at: conv.created_at || null,
  };
}

async function runPageBridge(tabId, bridgeMessage, injectFunc, args) {
  await ensureContentScript(tabId);

  const tab = await chrome.tabs.get(tabId);
  if (!CLAUDE_URL_PATTERN.test(tab.url || "")) {
    throw new Error(`tab is not a Claude page: ${tab.url || "unknown"}`);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("page fetch timed out after 60s"));
    }, 60000);

    chrome.tabs.sendMessage(
      tabId,
      bridgeMessage,
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "";
          if (msg.includes("Receiving end does not exist")) {
            reject(new Error(CLAUDE_TAB_CONNECT_ERROR));
            return;
          }
          reject(new Error(msg));
          return;
        }
        resolve(response);
      },
    );

    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: injectFunc,
        args,
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

async function fetchConversationListViaPageBridge(tabId, options = {}) {
  const fetchAll = options.fetchAll === true;
  const requestId = `list-${Date.now()}`;
  const eventName = `cad-conversation-list-${requestId}`;

  try {
    const result = await runPageBridge(
      tabId,
      { action: "listenForConversationList", eventName },
      (bridgeEventName, fetchAllFlag, pageSize) => {
        return (async () => {
          function dispatch(detail) {
            document.dispatchEvent(
              new CustomEvent(bridgeEventName, { detail }),
            );
          }

          function chatOrgs(data) {
            const orgs = Array.isArray(data)
              ? data
              : data.organizations || data.data || [];
            return orgs
              .filter((org) => {
                const caps = org.capabilities;
                return !caps || caps.includes("chat");
              })
              .map((org) => org.uuid || org.id)
              .filter(Boolean);
          }

          async function discoverOrgIds() {
            const ids = [];
            try {
              const response = await fetch("/api/organizations", {
                credentials: "include",
                headers: { Accept: "application/json" },
              });
              if (response.ok) {
                ids.push(...chatOrgs(await response.json()));
              }
            } catch {
              // ignore
            }
            return [...new Set(ids)];
          }

          const orgIds = await discoverOrgIds();
          if (!orgIds.length) {
            dispatch({
              conversations: [],
              error: "no chat-capable organizations found",
            });
            return;
          }

          const allConversations = [];
          const seen = new Set();
          const errors = [];

          for (const orgId of orgIds) {
            let offset = 0;
            let total = null;

            try {
              const countResp = await fetch(
                `/api/organizations/${orgId}/chat_conversations/count_all`,
                {
                  credentials: "include",
                  headers: { Accept: "application/json" },
                },
              );
              if (countResp.ok) {
                const countData = await countResp.json();
                total = countData.count ?? countData.total ?? null;
              }
            } catch {
              // ignore
            }

            while (true) {
              try {
                const path = `/api/organizations/${orgId}/chat_conversations?limit=${pageSize}&offset=${offset}&starred=false`;
                const response = await fetch(path, {
                  credentials: "include",
                  headers: { Accept: "application/json" },
                });
                if (!response.ok) {
                  errors.push(`HTTP ${response.status} for ${path}`);
                  break;
                }
                const data = await response.json();
                const batch = Array.isArray(data)
                  ? data
                  : data.conversations || data.data || [];
                for (const conv of batch) {
                  if (conv?.uuid && !seen.has(conv.uuid)) {
                    seen.add(conv.uuid);
                    allConversations.push({
                      uuid: conv.uuid,
                      name: conv.name || "Untitled",
                      updated_at: conv.updated_at || conv.created_at,
                      created_at: conv.created_at,
                    });
                  }
                }
                if (!fetchAllFlag) {
                  break;
                }
                offset += batch.length;
                if (batch.length < pageSize) {
                  break;
                }
                if (total !== null && offset >= total) {
                  break;
                }
              } catch (error) {
                errors.push(error.message);
                break;
              }
            }
          }

          allConversations.sort(
            (a, b) =>
              new Date(b.updated_at || 0) - new Date(a.updated_at || 0),
          );

          dispatch({
            conversations: allConversations,
            error: errors.length ? errors.join("; ") : null,
          });
        })();
      },
      [eventName, fetchAll, LIST_PAGE_SIZE],
    );

    const conversations = (result?.conversations || []).map(
      normalizeConversationSummary,
    );
    return {
      conversations,
      error: result?.error || null,
    };
  } catch (error) {
    return { conversations: [], error: error.message };
  }
}

async function fetchAllConversations(tabId) {
  const result = await fetchConversationListViaPageBridge(tabId, {
    fetchAll: true,
  });
  if (result.error && !result.conversations.length) {
    throw new Error(result.error);
  }
  return result.conversations;
}

async function fetchPayloadViaPageEventBridge(tabId, uuid, options = {}) {
  const rawOnly = options.rawOnly === true;

  try {
    const result = await runPageBridge(
      tabId,
      { action: "listenForPayload", uuid },
      (convUuid, onlyRaw) => {
        return (async () => {
          const eventName = `cad-payload-${convUuid}`;

          function dispatch(detail) {
            document.dispatchEvent(
              new CustomEvent(eventName, { detail }),
            );
          }

          // MAIN-world code cannot see CadExportCore: lib/export-core.js is
          // loaded as a content script (isolated world). Sniff the payload
          // shape inline here; the service worker does the real normalization.
          function sniffMessages(raw) {
            if (!raw || typeof raw !== "object") {
              return null;
            }
            const candidates = [
              raw,
              raw.conversation,
              raw.data,
              raw.result,
              raw.payload,
              raw.chat_conversation,
              raw.data?.conversation,
              raw.data?.chat_conversation,
              raw.result?.conversation,
            ].filter(Boolean);
            for (const candidate of candidates) {
              if (Array.isArray(candidate.chat_messages)) {
                return candidate.chat_messages;
              }
              if (Array.isArray(candidate.messages)) {
                return candidate.messages;
              }
            }
            return null;
          }

          function chatOrgs(data) {
            const orgs = Array.isArray(data)
              ? data
              : data.organizations || data.data || [];
            return orgs
              .filter((org) => {
                const caps = org.capabilities;
                return !caps || caps.includes("chat");
              })
              .map((org) => org.uuid || org.id)
              .filter(Boolean);
          }

          async function discoverOrgIds() {
            const ids = [];
            try {
              const response = await fetch("/api/organizations", {
                credentials: "include",
                headers: { Accept: "application/json" },
              });
              if (response.ok) {
                ids.push(...chatOrgs(await response.json()));
              }
            } catch {
              // ignore
            }
            return [...new Set(ids)];
          }

          const paramSets = onlyRaw
            ? [{ tree: "True", rendering_mode: "raw" }]
            : [
                {
                  tree: "True",
                  rendering_mode: "messages",
                  render_all_tools: "true",
                },
                { tree: "True", rendering_mode: "raw" },
              ];
          const orgIds = await discoverOrgIds();
          const errors = [];
          if (!orgIds.length) {
            dispatch({
              payload: null,
              error: "no chat-capable organizations found in page context",
              orgCount: 0,
            });
            return;
          }

          for (const orgId of orgIds) {
            for (const ps of paramSets) {
              const query = new URLSearchParams(ps).toString();
              const path = `/api/organizations/${orgId}/chat_conversations/${convUuid}?${query}`;
              const absoluteUrl = `https://claude.ai${path}`;
              try {
                const response = await fetch(path, {
                  credentials: "include",
                  headers: {
                    Accept: "application/json",
                    Referer: `https://claude.ai/chat/${convUuid}`,
                    "anthropic-client-platform": "web_claude_ai",
                  },
                });
                if (!response.ok) {
                  errors.push(`HTTP ${response.status} for ${path}`);
                  continue;
                }
                const json = await response.json();
                const sniffed = sniffMessages(json);
                if (sniffed) {
                  dispatch({
                    payload: json,
                    rawUrl: absoluteUrl,
                    orgCount: orgIds.length,
                    messageCount: sniffed.length,
                  });
                  return;
                }
                errors.push(`unusable payload from ${path}`);
              } catch (error) {
                errors.push(`${error.message} (${path})`);
              }
            }
          }

          dispatch({
            payload: null,
            error: errors.join("; ") || "all page fetches failed",
            orgCount: orgIds.length,
          });
        })();
      },
      [uuid, rawOnly],
    );

    if (isStorableChatPayload(result?.payload)) {
      if (result.rawUrl) {
        storeChatFetchMeta(uuid, result.rawUrl);
      }
      // The MAIN-world bridge dispatches the raw API JSON (it cannot reach
      // CadExportCore), so normalize here before handing it to callers that
      // expect a canonical payload with chat_messages.
      return { payload: normalizeChatPayload(result.payload) };
    }

    return {
      payload: null,
      error: result?.error || "page event returned no valid payload",
    };
  } catch (error) {
    return { payload: null, error: error.message };
  }
}

async function ensureChatPayload(uuid, tabId) {
  const cached = await getStoragePayload(uuid);
  if (isStorableChatPayload(cached)) {
    console.log(LOG_PREFIX, "cache hit for", uuid);
    return { payload: cached };
  }

  console.log(LOG_PREFIX, "cache miss for", uuid, "; attempting active fetch");
  const errors = [];
  let pageFetchAttempted = false;
  let pageFetchError = null;

  if (tabId) {
    pageFetchAttempted = true;
    console.log(LOG_PREFIX, "trying page-context fetch ...");
    const pageResult = await fetchPayloadViaPageEventBridge(tabId, uuid);
    if (pageResult.payload) {
      await storeChatPayload(pageResult.payload);
      console.log(
        LOG_PREFIX,
        "active fetch succeeded:",
        uuid,
        `(${pageResult.payload.chat_messages.length} messages)`,
      );
      return { payload: pageResult.payload };
    }
    pageFetchError = pageResult.error || "page-context fetch failed";
    errors.push(pageFetchError);
  } else {
    errors.push("no tab id for page-context fetch");
  }

  const meta = await getChatFetchMeta(uuid);
  if (meta?.rawUrl && !meta.rawUrl.includes("/task/")) {
    console.log(LOG_PREFIX, "trying stored raw URL ...", meta.rawUrl);
    const storedResult = await fetchPayloadFromUrl(meta.rawUrl, null, uuid);
    if (storedResult.payload) {
      await storeChatPayload(storedResult.payload);
      console.log(
        LOG_PREFIX,
        "active fetch succeeded:",
        uuid,
        `(${storedResult.payload.chat_messages.length} messages)`,
      );
      return { payload: storedResult.payload };
    }
    errors.push(storedResult.error || "stored raw URL failed");
  }

  const skipOrgDiscovery =
    pageFetchAttempted &&
    pageFetchError &&
    !pageFetchError.includes("no chat-capable organizations");

  if (!skipOrgDiscovery) {
    console.log(LOG_PREFIX, "trying organization discovery ...");
    const orgResult = await fetchPayloadViaOrgDiscovery(uuid);
    if (orgResult.payload) {
      await storeChatPayload(orgResult.payload);
      console.log(
        LOG_PREFIX,
        "active fetch succeeded:",
        uuid,
        `(${orgResult.payload.chat_messages.length} messages)`,
      );
      return { payload: orgResult.payload };
    }
    errors.push(orgResult.error || "organization discovery failed");
  }

  const detail = errors.filter(Boolean).join("; ");
  const summary = summarizeFetchError(errors);
  console.warn(LOG_PREFIX, "active fetch failed for", uuid, detail);
  return { payload: null, error: summary || "unknown" };
}
