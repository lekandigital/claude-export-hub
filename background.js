// background.js
importScripts("jszip.min.js");

const LOG_PREFIX = "[Claude Artifact Downloader]";
const CHAT_URL_PATTERN = /^https:\/\/claude\.ai\/chat\/[^/]+/;

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

async function handleDownloadArtifacts(request, sender) {
  const tabId = getTabId(sender, request);

  if (!request.uuid) {
    const msg = "No conversation UUID found.";
    notifyTab(tabId, { action: "artifactsProcessed", failure: true, message: msg });
    throw new Error(msg);
  }

  const payload = await getStoragePayload(request.uuid);
  if (!payload) {
    const msg = "No payload found, try refreshing the page.";
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

  if (artifactCount === 0) {
    const msg = "No artifacts found in this conversation.";
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

function processMessage(
  message,
  payload,
  zip,
  usedNames,
  artifactCount,
  useDirectoryStructure,
  depth = 0,
) {
  if (message.sender === "assistant" && message.text) {
    try {
      const artifacts = extractArtifacts(message.text);
      artifacts.forEach((artifact) => {
        artifactCount++;
        const fileName = getUniqueFileName(
          artifact.title,
          artifact.language,
          message.index,
          usedNames,
          useDirectoryStructure,
        );
        zip.file(fileName, artifact.content);
        console.log(`Added artifact: ${fileName}`);
      });
    } catch (error) {
      console.error(`Error processing message ${message.uuid}:`, error);
    }
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
    if (isChatRequest(obj) && !isOwnRequest(obj)) {
      fetchChat(obj).then((resp) => {
        if (!resp) {
          console.warn(
            LOG_PREFIX,
            "fetchChat returned no payload for",
            obj.url,
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
          console.warn(LOG_PREFIX, "Unusable chat payload:", obj.url, resp);
        }
      });
    }
  },
  { urls: ["https://api.claude.ai/api/*chat_conversations*"] },
  webRequestExtraInfoSpec,
);

function isChatRequest(obj) {
  return (
    obj.url.endsWith("?tree=True&rendering_mode=raw") && obj.method === "GET"
  );
}

function isOwnRequest(obj) {
  return (
    obj.requestHeaders?.some((header) => header.name === "X-Own-Request") ??
    false
  );
}

async function fetchChat(obj) {
  const headers = {};
  obj.requestHeaders.forEach((header) => (headers[header.name] = header.value));
  headers["X-Own-Request"] = "true";
  try {
    const response = await fetch(obj.url, {
      method: obj.method,
      headers: headers,
      credentials: "include",
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(LOG_PREFIX, "Fetch error:", error);
    return null;
  }
}
