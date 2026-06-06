// background.js
importScripts("jszip.min.js");

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
  return tabs[0]?.id ?? null;
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

function sanitizeFilename(name) {
  const sanitized = (name || "claude-artifacts")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/[\x00-\x1f]/g, "")
    .trim();
  return sanitized || "claude-artifacts";
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

function isStorableChatPayload(resp) {
  return !!(resp && resp.uuid && Array.isArray(resp.chat_messages));
}

function isValidChatPayload(resp) {
  return isStorableChatPayload(resp) && resp.chat_messages.length > 0;
}

async function storeChatPayload(resp) {
  await new Promise((resolve) => {
    chrome.storage.local.set({ [`chat_${resp.uuid}`]: resp }, resolve);
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
  thinking: false,
};

function normalizeExportIncludes(includes) {
  const src = includes || {};
  return {
    transcript: src.transcript !== false,
    artifacts: src.artifacts !== false,
    pasted: src.pasted !== false,
    thinking: src.thinking === true,
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

function getMostRecentRootMessage(payload) {
  const rootMessages = payload.chat_messages.filter(
    (message) =>
      message.parent_message_uuid === "00000000-0000-4000-8000-000000000000",
  );
  if (rootMessages.length === 0) {
    return null;
  }
  return rootMessages.reduce((latest, current) => {
    return new Date(current.updated_at) > new Date(latest.updated_at)
      ? current
      : latest;
  });
}

function buildChatFolderPrefix(payload) {
  const shortId = payload.uuid.slice(0, 8);
  return `${sanitizeFilename(payload.name || "chat")}_${shortId}/`;
}

function getActiveBranchMessages(payload) {
  const messages = payload.chat_messages || [];
  const byUuid = new Map(messages.map((m) => [m.uuid, m]));
  const nilUuid = "00000000-0000-4000-8000-000000000000";
  const leafUuid = payload.current_leaf_message_uuid;

  if (!leafUuid || !byUuid.has(leafUuid)) {
    const root = getMostRecentRootMessage(payload);
    if (!root) {
      return [];
    }
    const branch = [];
    let node = root;
    while (node) {
      branch.push(node);
      const children = messages
        .filter((m) => m.parent_message_uuid === node.uuid)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      node = children.length ? children[children.length - 1] : null;
    }
    return branch;
  }

  const branch = [];
  let current = byUuid.get(leafUuid);
  while (current) {
    branch.push(current);
    const parentUuid = current.parent_message_uuid;
    if (!parentUuid || parentUuid === nilUuid) {
      break;
    }
    current = byUuid.get(parentUuid);
    if (!current) {
      break;
    }
  }
  return branch.reverse();
}

function stripArtifactsFromText(text) {
  return text
    .replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getAttachmentExcerpts(message) {
  const excerpts = [];
  const sources = [
    ...(message.attachments || []),
    ...(message.files || []),
    ...(message.files_v2 || []),
  ];
  for (const att of sources) {
    const content = att.extracted_content || att.content;
    if (typeof content === "string" && content.trim()) {
      const name = att.file_name || att.filename || att.name || "attachment";
      excerpts.push({ name, content: content.trim() });
    }
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const blockBody =
        block.text ||
        block.content ||
        block.source?.data ||
        block.document?.content;
      if (
        block.type &&
        block.type !== "text" &&
        block.type !== "thinking" &&
        typeof blockBody === "string" &&
        blockBody.trim().length > 80
      ) {
        excerpts.push({
          name: block.title || block.name || block.type,
          content: blockBody.trim(),
        });
      }
    }
  }
  return excerpts;
}

function buildChatMarkdown(payload) {
  const messages = getActiveBranchMessages(payload);
  const lines = [`# ${payload.name || "Untitled Chat"}`, ""];

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

function collectCategorizedItemsFromPayload(payload) {
  const messages = getActiveBranchMessages(payload);
  const artifacts = [];
  const pasted = [];
  const seenArtifacts = new Set();
  const seenPasted = new Set();

  function addArtifact(item, messageIndex) {
    const key = `${item.title}::${item.content.slice(0, 120)}`;
    if (seenArtifacts.has(key)) {
      return;
    }
    seenArtifacts.add(key);
    artifacts.push({ ...item, messageIndex });
  }

  function addPasted(item, messageIndex) {
    const key = `${item.title}::${item.content.slice(0, 120)}`;
    if (seenPasted.has(key)) {
      return;
    }
    seenPasted.add(key);
    pasted.push({ ...item, messageIndex });
  }

  for (const message of messages) {
    const text = getMessageText(message);
    const index = message.index ?? 0;

    for (const artifact of extractArtifacts(text)) {
      addArtifact(artifact, index);
    }

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          for (const artifact of extractArtifacts(block.text)) {
            addArtifact(artifact, index);
          }
        }
      }
    }

    if (message.sender === "human" && text.trim().length > 80) {
      addPasted(
        {
          title: inferPastedTitle(text, "human"),
          language: "markdown",
          content: text.trim(),
        },
        index,
      );
    }
  }

  return { artifacts, pasted };
}

function collectThinkingItems(message) {
  const items = [];

  if (!Array.isArray(message.content)) {
    return items;
  }

  for (const [index, block] of message.content.entries()) {
    if (block.type === "thinking") {
      const content =
        block.thinking ||
        block.text ||
        block.content ||
        block.summary ||
        "";

      if (typeof content === "string" && content.trim()) {
        items.push({
          source: "payload",
          kind: "thinking",
          blockIndex: index,
          title: block.title || block.summary_title || "Visible thinking",
          content: content.trim(),
          signature: block.signature || null,
        });
      } else if (block.display === "omitted") {
        items.push({
          source: "payload",
          kind: "thinking",
          blockIndex: index,
          title: "Visible thinking",
          content: "[Thinking omitted]",
        });
      }
    }

    if (block.type === "redacted_thinking") {
      items.push({
        source: "payload",
        kind: "redacted_thinking",
        blockIndex: index,
        title: "Redacted thinking",
        content:
          "[Redacted thinking block present. The readable content is not available.]",
        redacted: true,
        dataLength: typeof block.data === "string" ? block.data.length : 0,
      });
    }
  }

  return items;
}

function collectThinkingFromPayload(payload) {
  const items = [];
  for (const message of getActiveBranchMessages(payload)) {
    if (message.sender !== "assistant") {
      continue;
    }
    for (const item of collectThinkingItems(message)) {
      items.push({
        ...item,
        messageUuid: message.uuid,
        messageIndex: message.index,
      });
    }
  }
  return items;
}

function thinkingDedupeKey(item) {
  return `${item.kind || "thinking"}:${(item.content || "").slice(0, 160)}`;
}

function domBlockToThinkingItem(block, capturedAt) {
  const partial = block.streaming === true;
  return {
    source: "dom",
    kind: "thinking",
    title: block.title || "Visible thinking",
    content: block.content || "",
    partial,
    streaming: partial,
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

async function getVisibleThinkingFromTab(tabId, uuid) {
  if (!tabId || !uuid) {
    return [];
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!CHAT_URL_PATTERN.test(tab.url || "")) {
      return [];
    }
    const tabUuid = tab.url.match(/\/chat\/([0-9a-f-]{36})/i)?.[1];
    if (tabUuid !== uuid) {
      return [];
    }
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVisibleThinking",
      uuid,
    });
    return response?.blocks || [];
  } catch {
    return [];
  }
}

async function collectThinkingForChat(payload, tabId, uuid) {
  const byKey = new Map();
  const chatUuid = uuid || payload.uuid;

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

function writeStructuredChatToZip(
  zip,
  payload,
  exportIncludes,
  folderPrefix,
  thinkingItems = [],
) {
  let fileCount = 0;
  const skipped = [];
  const chatName = payload.name || "Untitled";
  const messages = getActiveBranchMessages(payload);
  const { artifacts, pasted } = collectCategorizedItemsFromPayload(payload);

  if (exportIncludes.transcript) {
    if (messages.length === 0) {
      skipped.push(
        createCategorySkipRecord(
          payload,
          "transcript",
          "No messages on active branch",
        ),
      );
    } else {
      const markdown = buildChatMarkdown(payload);
      if (isTrivialTranscript(markdown, chatName)) {
        skipped.push(
          createCategorySkipRecord(payload, "transcript", "Transcript content is empty"),
        );
      } else {
        zip.file(`${folderPrefix}chat.md`, markdown);
        fileCount++;
      }
    }
  }

  if (exportIncludes.artifacts) {
    if (artifacts.length === 0) {
      skipped.push(
        createCategorySkipRecord(payload, "artifacts", "No artifacts found"),
      );
    } else {
      const usedNames = new Set();
      for (const item of artifacts) {
        const fileName = getUniqueFileName(
          item.title,
          item.language,
          item.messageIndex,
          usedNames,
        );
        zip.file(`${folderPrefix}artifacts/${fileName}`, item.content);
        fileCount++;
      }
    }
  }

  if (exportIncludes.pasted) {
    if (pasted.length === 0) {
      skipped.push(
        createCategorySkipRecord(
          payload,
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
          payload,
          "thinking",
          "No visible thinking found",
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
  const { exportIncludes, tabId, uuid, tryRawSupplement = false } = options;
  const folderPrefix = buildChatFolderPrefix(payload);

  let thinkingItems = [];
  if (exportIncludes.thinking) {
    thinkingItems = await collectThinkingForChat(payload, tabId, uuid);
  }

  let result = writeStructuredChatToZip(
    zip,
    payload,
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
        );
      }
      result = writeStructuredChatToZip(
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

  try {
    const { uuids, nameByUuid } = await resolveUuidList(request, tabId);

    await updateJobProgress(
      { phase: "fetching", total: uuids.length, current: 0 },
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

    const chatSkips = getChatLevelSkips(skipped);
    if (chatSkips.length > 0) {
      zip.file("export-skipped.txt", formatSkipReportText(chatSkips));
    }

    const scope = request.scope || "current";
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
    notifyTab(tabId, {
      action: "artifactsProcessed",
      failure: true,
      message: error.message,
    });
    throw error;
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

function getMessageText(message) {
  if (typeof message.text === "string" && message.text.trim()) {
    return message.text;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("\n\n");
  }
  return "";
}

function inferPastedTitle(text, sender) {
  const firstLine = text.trim().split("\n")[0].slice(0, 60);
  const cleaned = firstLine.replace(/[^\w\-._]+/g, "_").replace(/^_+|_+$/g, "");
  const prefix = sender === "human" ? "pasted" : "content";
  return cleaned ? `${prefix}_${cleaned}` : `${prefix}_message`;
}

function extractArtifacts(text) {
  const artifactRegex = /<antArtifact[^>]*>([\s\S]*?)<\/antArtifact>/g;
  const artifacts = [];
  let match;

  while ((match = artifactRegex.exec(text)) !== null) {
    const fullTag = match[0];
    const content = match[1];

    const titleMatch = fullTag.match(/title="([^"]*)/);
    const languageMatch = fullTag.match(/language="([^"]*)/);

    artifacts.push({
      title: titleMatch ? titleMatch[1] : "Untitled",
      language: languageMatch ? languageMatch[1] : "txt",
      content: content.trim(),
    });
  }

  return artifacts;
}

function getUniqueFileName(title, language, messageIndex, usedNames) {
  const baseName = title.replace(/[^\w\-._]+/g, "_");
  const extension = getFileExtension(language);

  let fileName = `${messageIndex + 1}_${baseName}${extension}`;
  if (usedNames.has(fileName)) {
    let suffixCount = 1;
    while (usedNames.has(fileName)) {
      const suffix = `_${"*".repeat(suffixCount)}`;
      fileName = `${messageIndex + 1}_${baseName}${suffix}${extension}`;
      suffixCount++;
    }
  }

  usedNames.add(fileName);
  return fileName;
}

function getFileExtension(language) {
  const languageToExt = {
    javascript: ".js",
    html: ".html",
    css: ".css",
    python: ".py",
    java: ".java",
    c: ".c",
    cpp: ".cpp",
    ruby: ".rb",
    php: ".php",
    swift: ".swift",
    go: ".go",
    rust: ".rs",
    typescript: ".ts",
    shell: ".sh",
    sql: ".sql",
    kotlin: ".kt",
    scala: ".scala",
    r: ".r",
    matlab: ".m",
    markdown: ".md",
    md: ".md",
    txt: ".txt",
  };
  return languageToExt[language.toLowerCase()] || ".txt";
}

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.url && CHAT_URL_PATTERN.test(changeInfo.url)) {
    chrome.tabs.sendMessage(tabId, { action: "checkAndAddDownloadButton" });
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
  return { payload: resp };
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
          reject(new Error(chrome.runtime.lastError.message));
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
                if (json?.uuid && Array.isArray(json?.chat_messages)) {
                  dispatch({
                    payload: json,
                    rawUrl: absoluteUrl,
                    orgCount: orgIds.length,
                    messageCount: json.chat_messages.length,
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
      return { payload: result.payload };
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
