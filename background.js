// background.js
importScripts("jszip.min.js");

const LOG_PREFIX = "[Claude Artifact Downloader]";
const CHAT_URL_PATTERN = /^https:\/\/claude\.ai\/chat\/[^/]+/;
const ORG_API_URLS = [
  "https://claude.ai/api/organizations",
  "https://api.claude.ai/api/organizations",
];

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

function getActiveFetchHeaders(uuid) {
  return {
    Accept: "application/json",
    "X-Own-Request": "true",
    Referer: `https://claude.ai/chat/${uuid}`,
    "anthropic-client-platform": "web_claude_ai",
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "downloadArtifacts") {
    return false;
  }

  handleDownloadArtifacts(request, sender)
    .then((result) => sendResponse({ success: true, ...result }))
    .catch((err) => sendResponse({ success: false, error: err.message }));

  return true;
});

function getTabId(sender, request) {
  return request.tabId ?? sender.tab?.id;
}

function notifyTab(tabId, payload) {
  if (!tabId) {
    return;
  }
  chrome.tabs.sendMessage(tabId, payload, () => {
    if (chrome.runtime.lastError) {
      console.warn(LOG_PREFIX, "Could not notify tab:", chrome.runtime.lastError.message);
    }
  });
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

function isValidChatPayload(resp) {
  return !!(
    resp &&
    resp.uuid &&
    Array.isArray(resp.chat_messages) &&
    resp.chat_messages.length > 0
  );
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
    const uuidMatch = url.pathname.match(/chat_conversations\/([0-9a-f-]{36})/i);
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

async function handleDownloadArtifacts(request, sender) {
  const tabId = getTabId(sender, request);

  if (!request.uuid) {
    const msg = "No conversation UUID found.";
    notifyTab(tabId, { action: "artifactsProcessed", failure: true, message: msg });
    throw new Error(msg);
  }

  console.log(LOG_PREFIX, "download requested for", request.uuid);
  const { payload, error: fetchError } = await ensureChatPayload(
    request.uuid,
    tabId,
  );
  if (!payload) {
    const msg = `Could not fetch Claude conversation payload. Open the extension service worker console and check the active-fetch logs. Last error: ${fetchError || "unknown"}`;
    notifyTab(tabId, { action: "artifactsProcessed", failure: true, message: msg });
    throw new Error(msg);
  }

  if (!payload.chat_messages || payload.chat_messages.length === 0) {
    const msg = "No chat messages found in cached payload.";
    notifyTab(tabId, { action: "artifactsProcessed", failure: true, message: msg });
    throw new Error(msg);
  }

  const chatData = payload;
  const zip = new JSZip();
  let artifactCount = 0;
  const usedNames = new Set();

  const rootMessages = payload.chat_messages.filter(
    (message) =>
      message.parent_message_uuid === "00000000-0000-4000-8000-000000000000",
  );

  let mostRecentRootMessage = null;
  if (rootMessages.length > 0) {
    mostRecentRootMessage = rootMessages.reduce((latest, current) => {
      return new Date(current.updated_at) > new Date(latest.updated_at)
        ? current
        : latest;
    });
  }

  const useDirectoryStructure = request.useDirectoryStructure;

  if (mostRecentRootMessage) {
    artifactCount = processMessage(
      mostRecentRootMessage,
      payload,
      zip,
      usedNames,
      0,
      useDirectoryStructure,
    );
  }

  if (artifactCount === 0 && tabId) {
    console.log(
      LOG_PREFIX,
      "no export items in cached payload; trying raw-mode supplement",
    );
    const rawSupplement = await fetchPayloadViaPageEventBridge(
      tabId,
      request.uuid,
      { rawOnly: true },
    );
    if (rawSupplement.payload && mostRecentRootMessage) {
      artifactCount = processMessage(
        mostRecentRootMessage,
        rawSupplement.payload,
        zip,
        usedNames,
        0,
        useDirectoryStructure,
      );
      if (artifactCount > 0) {
        await storeChatPayload(rawSupplement.payload);
      }
    }
  }

  if (artifactCount === 0) {
    const msg =
      "No exportable content found (artifacts, pasted text, or attachments).";
    notifyTab(tabId, {
      action: "artifactsProcessed",
      success: true,
      message: msg,
    });
    return { message: msg, artifactCount: 0 };
  }

  try {
    const base64 = await zip.generateAsync({ type: "base64" });
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: `data:application/zip;base64,${base64}`,
          filename: `${sanitizeFilename(chatData.name)}.zip`,
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

    const msg = `${artifactCount} artifacts downloaded successfully.`;
    notifyTab(tabId, {
      action: "artifactsProcessed",
      success: true,
      message: msg,
    });
    return { message: msg, artifactCount };
  } catch (error) {
    console.error(LOG_PREFIX, "ZIP download error:", error);
    const msg = "Error downloading artifacts.";
    notifyTab(tabId, {
      action: "artifactsProcessed",
      failure: true,
      message: msg,
    });
    throw error;
  }
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

function inferLanguageFromFileType(fileType) {
  if (!fileType) {
    return "txt";
  }
  const ft = String(fileType).toLowerCase();
  if (ft.includes("markdown") || ft === "md" || ft.endsWith(".md")) {
    return "markdown";
  }
  if (ft.includes("json")) {
    return "json";
  }
  if (ft.includes("html")) {
    return "html";
  }
  if (ft.includes("python") || ft === "py") {
    return "python";
  }
  if (ft.includes("javascript") || ft === "js") {
    return "javascript";
  }
  return "txt";
}

function inferPastedTitle(text, sender) {
  const firstLine = text.trim().split("\n")[0].slice(0, 60);
  const cleaned = firstLine.replace(/[^\w\-._]+/g, "_").replace(/^_+|_+$/g, "");
  const prefix = sender === "human" ? "pasted" : "content";
  return cleaned ? `${prefix}_${cleaned}` : `${prefix}_message`;
}

function collectExportItems(message) {
  const items = [];
  const seen = new Set();
  const text = getMessageText(message);

  function addItem(item) {
    const content = item.content?.trim();
    if (!content) {
      return;
    }
    const key = `${item.title}::${content.slice(0, 120)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    items.push({ ...item, content });
  }

  for (const artifact of extractArtifacts(text)) {
    addItem(artifact);
  }

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "thinking") {
        continue;
      }
      if (block.type === "text" && block.text) {
        for (const artifact of extractArtifacts(block.text)) {
          addItem(artifact);
        }
      }
      const blockBody =
        block.text ||
        block.content ||
        block.source?.data ||
        block.document?.content;
      if (typeof blockBody === "string" && blockBody.length > 100) {
        if (block.type && block.type !== "text") {
          addItem({
            title: block.title || block.name || block.type,
            language: "txt",
            content: blockBody,
          });
        }
      }
      if (block.type === "tool_result" && typeof block.content === "string") {
        addItem({
          title: "tool_result",
          language: "txt",
          content: block.content,
        });
      }
    }
  }

  const attachmentSources = [
    ...(message.attachments || []),
    ...(message.files || []),
    ...(message.files_v2 || []),
  ];
  for (const att of attachmentSources) {
    const content = att.extracted_content || att.content;
    if (typeof content === "string") {
      addItem({
        title: att.file_name || att.filename || att.name || "attachment",
        language: inferLanguageFromFileType(att.file_type || att.mime_type),
        content,
      });
    }
  }

  if (message.sender === "human" && text.trim().length > 80) {
    addItem({
      title: inferPastedTitle(text, "human"),
      language: "markdown",
      content: text.trim(),
    });
  }

  return items;
}

function processMessage(
  message,
  payload,
  zip,
  usedNames,
  artifactCount,
  useDirectoryStructure,
  depth = 0,
) {
  try {
    const exportItems = collectExportItems(message);
    exportItems.forEach((item) => {
      artifactCount++;
      const fileName = getUniqueFileName(
        item.title,
        item.language,
        message.index,
        usedNames,
        useDirectoryStructure,
      );
      zip.file(fileName, item.content);
      console.log(`Added export item: ${fileName}`);
    });
  } catch (error) {
    console.error(`Error processing message ${message.uuid}:`, error);
  }

  if (depth > 100) {
    console.warn(
      "Maximum recursion depth reached. Stopping message processing.",
    );
    return artifactCount;
  }

  const childMessages = payload.chat_messages.filter(
    (m) => m.parent_message_uuid === message.uuid,
  );

  childMessages
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .forEach((childMessage) => {
      artifactCount = processMessage(
        childMessage,
        payload,
        zip,
        usedNames,
        artifactCount,
        useDirectoryStructure,
        depth + 1,
      );
    });

  return artifactCount;
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

function getUniqueFileName(
  title,
  language,
  messageIndex,
  usedNames,
  useDirectoryStructure,
) {
  let baseName = title.replace(/[^\w\-._]+/g, "_");
  let extension = getFileExtension(language);

  let fileName = useDirectoryStructure
    ? inferDirectoryStructure(baseName, extension)
    : `${messageIndex + 1}_${baseName}${extension}`;
  if (usedNames.has(fileName)) {
    let suffix = "";
    let suffixCount = 1;
    while (usedNames.has(fileName)) {
      suffix = `_${"*".repeat(suffixCount)}`;
      fileName = useDirectoryStructure
        ? inferDirectoryStructure(baseName, extension, messageIndex, suffix)
        : `${messageIndex + 1}_${baseName}${suffix}${extension}`;
      suffixCount++;
    }
  }

  usedNames.add(fileName);
  return fileName;
}

function inferDirectoryStructure(
  baseName,
  extension,
  messageIndex = null,
  suffix = "",
) {
  const parts = baseName.split("/");
  if (parts.length > 1) {
    const fileName = `${parts.pop()}${suffix}${extension}`;
    const directory = parts.join("/");
    return messageIndex !== null
      ? `${directory}/${messageIndex + 1}_${fileName}`
      : `${directory}/${fileName}`;
  }
  return messageIndex !== null
    ? `${messageIndex + 1}_${baseName}${suffix}${extension}`
    : `${baseName}${suffix}${extension}`;
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

    const fetchUrl =
      parsed.renderingMode === "raw" ? obj.url : rawUrl;
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

    fetchChat(fetchUrl, obj.method, obj.requestHeaders).then((resp) => {
      if (!resp) {
        console.warn(
          LOG_PREFIX,
          "fetchChat returned no payload for",
          fetchUrl,
        );
        return;
      }
      if (resp.chat_messages && resp.uuid) {
        console.log(
          LOG_PREFIX,
          "Stored chat payload:",
          resp.uuid,
          `(${resp.chat_messages.length} messages)`,
        );
        chrome.storage.local.set({ [`chat_${resp.uuid}`]: resp });
      } else {
        console.warn(LOG_PREFIX, "Unusable chat payload:", fetchUrl, resp);
      }
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
  const headers = uuid ? getActiveFetchHeaders(uuid) : { Accept: "application/json" };
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
  if (!isValidChatPayload(resp)) {
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

async function fetchPayloadViaPageEventBridge(tabId, uuid, options = {}) {
  const rawOnly = options.rawOnly === true;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!CHAT_URL_PATTERN.test(tab.url || "")) {
      return {
        payload: null,
        error: `tab is not a Claude chat page: ${tab.url || "unknown"}`,
      };
    }

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("page fetch timed out after 30s"));
      }, 30000);

      chrome.tabs.sendMessage(
        tabId,
        { action: "listenForPayload", uuid },
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
          func: (convUuid, onlyRaw) => {
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
                    if (json?.uuid && json?.chat_messages?.length) {
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
          args: [uuid, rawOnly],
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });

    if (isValidChatPayload(result?.payload)) {
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
  if (isValidChatPayload(cached)) {
    console.log(LOG_PREFIX, "cache hit for", uuid);
    return { payload: cached };
  }

  console.log(LOG_PREFIX, "cache miss for", uuid, "; attempting active fetch");
  const errors = [];

  if (tabId) {
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
    errors.push(pageResult.error || "page-context fetch failed");
  } else {
    errors.push("no tab id for page-context fetch");
  }

  const meta = await getChatFetchMeta(uuid);
  if (meta?.rawUrl) {
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

  const reason = errors.filter(Boolean).join("; ");
  console.log(LOG_PREFIX, "active fetch failed:", reason);
  return { payload: null, error: reason || "unknown" };
}
