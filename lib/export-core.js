/**
 * Shared export logic for Claude Export Hub (browser + Node tests).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.CadExportCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const LOG_PREFIX = "[Claude Export Hub]";

  function elementText(el) {
    if (!el) {
      return "";
    }
    return cleanText(el.innerText || el.textContent || "");
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function sanitizeFilename(name) {
    const sanitized = String(name || "untitled")
      .replace(/[^\w\-._+() ]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120);
    return sanitized || "untitled";
  }

  function dedupeTitleFromBody(title, body) {
    let output = body.trim();
    while (output.startsWith(title)) {
      output = output.slice(title.length).trim();
    }
    return output;
  }

  function isLikelyChatMessage(item) {
    return (
      item &&
      typeof item === "object" &&
      (item.sender === "human" ||
        item.sender === "assistant" ||
        item.role === "user" ||
        item.role === "assistant") &&
      (item.uuid || item.id || item.content || item.text)
    );
  }

  function unwrapPayloadCandidate(raw) {
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
        return candidate;
      }
      if (Array.isArray(candidate.messages) && candidate.messages.some(isLikelyChatMessage)) {
        return { ...candidate, chat_messages: candidate.messages };
      }
    }

    return null;
  }

  function normalizeChatPayload(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const source = unwrapPayloadCandidate(raw);
    if (!source) {
      return null;
    }

    const uuid =
      source.uuid ||
      source.id ||
      raw.uuid ||
      raw.id ||
      source.conversation_uuid ||
      null;

    if (!uuid || !Array.isArray(source.chat_messages)) {
      return null;
    }

    const messages = source.chat_messages.map((message, index) => {
      if (message.index == null) {
        return { ...message, index };
      }
      return message;
    });

    return {
      ...source,
      uuid,
      name: source.name || source.title || raw.name || raw.title || "Untitled",
      chat_messages: messages,
      current_leaf_message_uuid:
        source.current_leaf_message_uuid ||
        source.leaf_message_uuid ||
        source.current_leaf_uuid ||
        raw.current_leaf_message_uuid ||
        null,
    };
  }

  function isStorableChatPayload(resp) {
    const normalized = normalizeChatPayload(resp);
    return !!(normalized && normalized.uuid && Array.isArray(normalized.chat_messages));
  }

  function isValidChatPayload(resp) {
    const normalized = normalizeChatPayload(resp);
    return (
      isStorableChatPayload(resp) &&
      normalized.chat_messages.length > 0
    );
  }

  function getMostRecentRootMessage(payload) {
    const messages = payload.chat_messages || [];
    const rootMessages = messages.filter(
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

  function getActiveBranchMessages(payload) {
    const normalized = normalizeChatPayload(payload) || payload;
    const messages = normalized.chat_messages || [];
    const byUuid = new Map(messages.map((m) => [m.uuid, m]));
    const nilUuid = "00000000-0000-4000-8000-000000000000";
    const leafUuid = normalized.current_leaf_message_uuid;

    if (!leafUuid || !byUuid.has(leafUuid)) {
      const root = getMostRecentRootMessage(normalized);
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

  function stripArtifactsFromText(text) {
    return text
      .replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
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
        source: "antArtifact",
        category: "artifacts",
      });
    }

    return artifacts;
  }

  function inferLanguageFromFile(file) {
    return (
      file.language ||
      file.file_type ||
      file.mime_type ||
      file.type ||
      "txt"
    );
  }

  function inferFileTitle(file, fallback) {
    return (
      file.title ||
      file.file_name ||
      file.filename ||
      file.name ||
      fallback ||
      "Untitled"
    );
  }

  function extractFileContent(file) {
    const candidates = [
      file.extracted_content,
      file.content,
      file.text,
      file.data,
      file.source?.data,
      file.document?.content,
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  }

  function extractContentBlockFile(block, messageIndex) {
    const blockBody =
      block.text ||
      block.content ||
      block.source?.data ||
      block.document?.content ||
      block.code ||
      block.result ||
      "";

    if (typeof blockBody !== "string" || !blockBody.trim()) {
      return null;
    }

    const type = String(block.type || "block").toLowerCase();
    if (type === "text" || type === "thinking" || type === "redacted_thinking") {
      return null;
    }

    let category = "artifacts";
    if (type.includes("tool") || type === "tool_result" || type === "tool_use") {
      category = "generated-files";
    } else if (type === "document" || type === "artifact" || type === "code") {
      category = "artifacts";
    } else if (type === "file" || type === "image") {
      category = "attachments";
    }

    return {
      title: block.title || block.name || `${type}_${messageIndex + 1}`,
      language: block.language || inferLanguageFromFile(block),
      content: blockBody.trim(),
      source: `content:${type}`,
      category,
      blockType: type,
    };
  }

  function categorizeMessageFile(file, sourceKey) {
    const content = extractFileContent(file);
    if (!content) {
      return null;
    }

    let category = "attachments";
    if (sourceKey === "files_v2" || file.presented || file.is_presented) {
      category = "presented-files";
    } else if (sourceKey === "files" || file.generated || file.is_generated) {
      category = "generated-files";
    } else if (sourceKey === "attachments") {
      category = "attachments";
    }

    return {
      title: inferFileTitle(file, `${sourceKey}_file`),
      language: inferLanguageFromFile(file),
      content,
      source: sourceKey,
      category,
    };
  }

  function fileDedupeKey(item) {
    return `${item.category}:${item.title}:${item.content.slice(0, 160)}`;
  }

  function collectFilesFromMessage(message, messageIndex) {
    const items = [];
    const sourceMap = {
      attachments: message.attachments,
      files: message.files,
      files_v2: message.files_v2,
    };

    for (const [sourceKey, list] of Object.entries(sourceMap)) {
      if (!Array.isArray(list)) {
        continue;
      }
      for (const file of list) {
        const item = categorizeMessageFile(file, sourceKey);
        if (item) {
          items.push({ ...item, messageIndex });
        }
      }
    }

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const item = extractContentBlockFile(block, messageIndex);
        if (item) {
          items.push({ ...item, messageIndex });
        }
        if (block.type === "text" && block.text) {
          for (const artifact of extractArtifacts(block.text)) {
            items.push({ ...artifact, messageIndex });
          }
        }
      }
    }

    return items;
  }

  function inferPastedTitle(text, sender) {
    const firstLine = text.trim().split("\n")[0].slice(0, 60);
    const cleaned = firstLine.replace(/[^\w\-._]+/g, "_").replace(/^_+|_+$/g, "");
    const prefix = sender === "human" ? "pasted" : "content";
    return cleaned ? `${prefix}_${cleaned}` : `${prefix}_message`;
  }

  function collectCategorizedItemsFromPayload(payload) {
    const messages = getActiveBranchMessages(payload);
    const artifacts = [];
    const attachments = [];
    const presentedFiles = [];
    const generatedFiles = [];
    const pasted = [];
    const seen = new Set();

    function addItem(bucket, item, messageIndex) {
      const key = fileDedupeKey(item);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      bucket.push({ ...item, messageIndex });
    }

    for (const message of messages) {
      const text = getMessageText(message);
      const index = message.index ?? 0;

      for (const artifact of extractArtifacts(text)) {
        addItem(artifacts, artifact, index);
      }

      for (const fileItem of collectFilesFromMessage(message, index)) {
        if (fileItem.category === "presented-files") {
          addItem(presentedFiles, fileItem, index);
        } else if (fileItem.category === "generated-files") {
          addItem(generatedFiles, fileItem, index);
        } else if (fileItem.category === "attachments") {
          addItem(attachments, fileItem, index);
        } else {
          addItem(artifacts, fileItem, index);
        }
      }

      if (message.sender === "human" && text.trim().length > 80) {
        const pastedKey = `pasted:${text.slice(0, 120)}`;
        if (!seen.has(pastedKey)) {
          seen.add(pastedKey);
          pasted.push({
            title: inferPastedTitle(text, "human"),
            language: "markdown",
            content: text.trim(),
            messageIndex: index,
          });
        }
      }
    }

    return { artifacts, attachments, presentedFiles, generatedFiles, pasted };
  }

  function getAttachmentExcerpts(message) {
    const excerpts = [];
    const sources = [
      ...(message.attachments || []),
      ...(message.files || []),
      ...(message.files_v2 || []),
    ];
    for (const att of sources) {
      const content = extractFileContent(att);
      if (content) {
        excerpts.push({
          name: inferFileTitle(att, "attachment"),
          content,
        });
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
          block.type !== "redacted_thinking" &&
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
    return `${item.kind || "thinking"}:${item.title || ""}:${(item.content || "").slice(0, 160)}`;
  }

  function isStatusPanelButton(button) {
    if (!button || button.tagName !== "BUTTON") {
      return false;
    }
    const className = button.className || "";
    if (className.includes("group/status")) {
      return true;
    }
    if (button.getAttribute("aria-expanded") == null) {
      return false;
    }
    const title = cleanText(button.innerText || button.textContent || "");
    return looksLikeStatusOrThinkingTitle(title);
  }

  function looksLikeStatusOrThinkingTitle(title) {
    if (!title) {
      return false;
    }
    const lower = title.toLowerCase();
    const keywords = [
      "thinking",
      "synthesiz",
      "analyz",
      "review",
      "check",
      "curat",
      "plan",
      "extract",
      "viewed",
      "edited",
      "presented",
      "retriev",
      "diagnos",
      "created a file",
      "ran a command",
      "read a file",
      "mapping",
      "catalog",
      "scrutin",
      "decided",
    ];
    return keywords.some((word) => lower.includes(word));
  }

  function extractStatusTitle(button) {
    const labeled =
      button.querySelector(".truncate.font-base") ||
      button.querySelector(".truncate") ||
      button.querySelector("span.truncate");
    if (labeled) {
      return cleanText(labeled.textContent || labeled.innerText || "");
    }
    return cleanText(button.innerText || button.textContent || "").split("\n")[0];
  }

  function extractStatusPanelBody(button) {
    const rowHost =
      button.closest(".row-start-1") ||
      button.closest("[class*='row-start-1']") ||
      button.parentElement?.parentElement;

    if (!rowHost) {
      return "";
    }

    const collapsible =
      rowHost.querySelector('[style*="grid-template-rows"]') ||
      rowHost.querySelector('[class*="grid-template-rows"]');

    if (!collapsible) {
      return "";
    }

    const style = collapsible.getAttribute("style") || "";
    const isCollapsed =
      style.includes("grid-template-rows:0fr") ||
      style.includes("grid-template-rows: 0fr");

    const timeline =
      collapsible.querySelector('[class*="group/timeline-text"]') ||
      collapsible.querySelector('[class*="timeline-text"]') ||
      collapsible.querySelector(".standard-markdown");

    if (!timeline) {
      return isCollapsed ? "" : elementText(collapsible);
    }

    return elementText(timeline);
  }

  function findAssistantTurns(doc) {
    const turns = [
      ...doc.querySelectorAll("[data-is-streaming]"),
      ...doc.querySelectorAll(".group.relative.pb-3"),
    ];

    if (turns.length) {
      const unique = [];
      const seen = new Set();
      for (const turn of turns) {
        if (!seen.has(turn)) {
          seen.add(turn);
          unique.push(turn);
        }
      }
      return unique;
    }

    const statusButtons = [...doc.querySelectorAll('button[class*="group/status"]')];
    const ancestors = [];
    for (const button of statusButtons) {
      const host =
        button.closest("[data-is-streaming]") ||
        button.closest(".group.relative.pb-3") ||
        button.closest(".font-claude-response") ||
        button.closest("div.mt-4")?.parentElement;
      if (host && !ancestors.includes(host)) {
        ancestors.push(host);
      }
    }
    return ancestors;
  }

  function findTurnIndex(element, turns) {
    for (const [index, turn] of turns.entries()) {
      if (turn.contains(element)) {
        return index;
      }
    }
    return turns.length;
  }

  function isStreamingAncestor(element) {
    const streamingHost = element.closest("[data-is-streaming]");
    return streamingHost?.getAttribute("data-is-streaming") === "true";
  }

  function isMainAssistantResponseText(element) {
    return !!element.closest(".row-start-2");
  }

  function collectVisibleStatusFromDom(doc) {
    const documentRoot = doc || (typeof document !== "undefined" ? document : null);
    if (!documentRoot) {
      return [];
    }

    const turns = findAssistantTurns(documentRoot);
    const results = [];
    const seen = new Set();

    const statusButtons = [
      ...new Set([
        ...documentRoot.querySelectorAll('button[class*="group/status"]'),
        ...[...documentRoot.querySelectorAll("button[aria-expanded]")].filter(
          isStatusPanelButton,
        ),
      ]),
    ];

    for (const button of statusButtons) {
      if (isMainAssistantResponseText(button)) {
        continue;
      }

      const title = extractStatusTitle(button);
      if (!title) {
        continue;
      }

      const expanded = button.getAttribute("aria-expanded") === "true";
      const rawBody = extractStatusPanelBody(button);
      const content = dedupeTitleFromBody(title, rawBody);
      const turnIndex = findTurnIndex(button, turns);

      const turnContainer =
        button.closest("[data-is-streaming]") ||
        button.closest(".group.relative.pb-3") ||
        button.closest(".grid.grid-rows-\\[auto_auto\\]") ||
        button.parentElement;

      const siblingButtons = turnContainer
        ? [...turnContainer.querySelectorAll('button[class*="group/status"], button[aria-expanded]')].filter(
            isStatusPanelButton,
          )
        : [];
      const blockIndex = siblingButtons.indexOf(button);

      const dedupeContent = content || (expanded ? "" : title);
      const key = `${turnIndex}:${title}:${dedupeContent.slice(0, 100)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      if (
        !content &&
        !expanded &&
        !looksLikeStatusOrThinkingTitle(title)
      ) {
        continue;
      }

      results.push({
        source: "dom",
        kind: expanded || content ? "status" : "status-collapsed",
        turnIndex,
        blockIndex: blockIndex >= 0 ? blockIndex : results.length,
        title,
        content: content || (expanded ? "" : `[Collapsed: ${title}]`),
        expanded,
        collapsed: !expanded,
        streaming: isStreamingAncestor(button),
      });
    }

    return results;
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
      pdf: ".pdf",
      json: ".json",
    };
    const key = String(language || "txt")
      .toLowerCase()
      .replace(/^.*\//, "")
      .replace(/^\./, "");
    return languageToExt[key] || (key.startsWith(".") ? key : ".txt");
  }

  function getUniqueFileName(title, language, messageIndex, usedNames) {
    const baseName = sanitizeFilename(title).replace(/[^\w\-._]+/g, "_");
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

  function buildExportDiagnostics(payload, options = {}) {
    const normalized = normalizeChatPayload(payload);
    const messages = normalized ? getActiveBranchMessages(normalized) : [];
    const categorized = normalized
      ? collectCategorizedItemsFromPayload(normalized)
      : {
          artifacts: [],
          attachments: [],
          presentedFiles: [],
          generatedFiles: [],
          pasted: [],
        };
    const thinkingPayload = normalized ? collectThinkingFromPayload(normalized) : [];
    const domBlocks = options.domBlocks || [];

    const fileCount =
      categorized.artifacts.length +
      categorized.attachments.length +
      categorized.presentedFiles.length +
      categorized.generatedFiles.length;

    const diagnostics = {
      messages: messages.length,
      artifacts: categorized.artifacts.length,
      attachments: categorized.attachments.length,
      presentedFiles: categorized.presentedFiles.length,
      generatedFiles: categorized.generatedFiles.length,
      pasted: categorized.pasted.length,
      thinkingPayload: thinkingPayload.length,
      thinkingDom: domBlocks.length,
      thinkingTotal: thinkingPayload.length + domBlocks.length,
      skipped: [],
    };

    if (!normalized) {
      diagnostics.skipped.push({ category: "payload", reason: "Could not normalize payload" });
    } else if (!messages.length) {
      diagnostics.skipped.push({ category: "transcript", reason: "No messages on active branch" });
    }
    if (!fileCount) {
      diagnostics.skipped.push({ category: "files", reason: "No artifacts/files found in payload" });
    }
    if (!thinkingPayload.length && !domBlocks.length) {
      diagnostics.skipped.push({
        category: "thinking",
        reason: "No visible thinking/status blocks in payload or DOM",
      });
    }

    return diagnostics;
  }

  function logExportDiagnostics(payload, options = {}) {
    const diagnostics = buildExportDiagnostics(payload, options);
    console.log(LOG_PREFIX, "export diagnostics:", diagnostics);
    return diagnostics;
  }

  return {
    LOG_PREFIX,
    cleanText,
    sanitizeFilename,
    dedupeTitleFromBody,
    normalizeChatPayload,
    isStorableChatPayload,
    isValidChatPayload,
    getActiveBranchMessages,
    getMostRecentRootMessage,
    getMessageText,
    stripArtifactsFromText,
    extractArtifacts,
    collectFilesFromMessage,
    collectCategorizedItemsFromPayload,
    getAttachmentExcerpts,
    collectThinkingItems,
    collectThinkingFromPayload,
    thinkingDedupeKey,
    collectVisibleStatusFromDom,
    looksLikeStatusOrThinkingTitle,
    isStatusPanelButton,
    getFileExtension,
    getUniqueFileName,
    inferPastedTitle,
    buildExportDiagnostics,
    logExportDiagnostics,
  };
});
