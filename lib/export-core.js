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
      file.display_name ||
      file.document?.title ||
      fallback ||
      "Untitled"
    );
  }

  function inferFileId(file) {
    return (
      file.file_uuid ||
      file.file_id ||
      file.uuid ||
      file.id ||
      file.attachment_uuid ||
      null
    );
  }

  function inferFileMimeType(file) {
    return (
      file.mime_type ||
      file.file_type ||
      file.media_type ||
      file.type ||
      null
    );
  }

  function inferFileSize(file) {
    const raw = file.size ?? file.file_size ?? file.size_bytes ?? null;
    return raw;
  }

  /**
   * Recursively extract text from nested values.
   * Handles strings, arrays (joined with blank lines), and objects with
   * common text-bearing keys.
   */
  function nestedText(value) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      return value
        .map(nestedText)
        .filter(Boolean)
        .join("\n\n")
        .trim();
    }
    if (value && typeof value === "object") {
      const nested =
        value.text ||
        value.content ||
        value.extracted_content ||
        value.extracted_text ||
        value.markdown ||
        value.data ||
        value.body ||
        value.summary ||
        value.plain_text ||
        value.contents;
      if (nested !== undefined) {
        return nestedText(nested);
      }
    }
    return "";
  }

  function extractFileContent(file) {
    const candidates = [
      file.extracted_content,
      file.extracted_text,
      file.plain_text,
      file.markdown,
      file.content,
      file.contents,
      file.text,
      file.data,
      file.body,
      file.summary,
      file.source?.data,
      file.source?.text,
      file.source?.content,
      file.document?.content,
      file.document?.text,
      file.file?.content,
      file.file?.text,
    ];
    for (const value of candidates) {
      const text = nestedText(value);
      if (text) {
        return text;
      }
    }
    return "";
  }

  /**
   * Collect safe download URLs from a file object.
   */
  function extractFileUrls(file) {
    const urlCandidates = [
      file.url,
      file.download_url,
      file.downloadUrl,
      file.file_url,
      file.fileUrl,
      file.source?.url,
      file.document?.url,
      file.attachment?.url,
      file.file?.url,
    ];
    const urls = [];
    const seen = new Set();
    for (const u of urlCandidates) {
      if (typeof u === "string" && u.trim() && !seen.has(u)) {
        seen.add(u);
        urls.push(u);
      }
    }
    return urls;
  }

  /**
   * Returns true if a file object has enough identity metadata to be
   * worth exporting even without readable text content.
   */
  function hasFileIdentity(file) {
    return !!(
      inferFileTitle(file, "") ||
      inferFileId(file) ||
      inferFileMimeType(file) ||
      inferFileSize(file) != null ||
      extractFileUrls(file).length > 0
    );
  }

  /**
   * Build a markdown representation of file metadata for attachments
   * where no readable text was available.
   */
  function buildMetadataMarkdown(file, sourceKey) {
    const title = inferFileTitle(file, `${sourceKey}_file`);
    const rows = [
      `# ${title}`,
      "",
      "Claude exposed this attachment/file card in the conversation payload, "
        + "but did not include readable file text in the cached API response.",
      "",
      "## Metadata",
      "",
      `- Source: ${sourceKey}`,
    ];
    const id = inferFileId(file);
    const mimeType = inferFileMimeType(file);
    const size = inferFileSize(file);
    const urls = extractFileUrls(file);
    const created = file.created_at || file.createdAt || null;
    if (id) rows.push(`- File ID: ${id}`);
    if (mimeType) rows.push(`- Type: ${mimeType}`);
    if (size != null) rows.push(`- Size: ${size}`);
    if (created) rows.push(`- Created: ${created}`);
    for (const u of urls) {
      rows.push(`- URL: ${u}`);
    }
    rows.push("");
    return rows.join("\n");
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
    if (!file || typeof file !== "object") {
      return null;
    }

    const content = extractFileContent(file);
    const metadataOnly = !content && hasFileIdentity(file);

    if (!content && !metadataOnly) {
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

    const urls = extractFileUrls(file);
    const fileId = inferFileId(file);
    const mimeType = inferFileMimeType(file);
    const size = inferFileSize(file);

    return {
      title: inferFileTitle(file, `${sourceKey}_file`),
      language: metadataOnly ? "markdown" : inferLanguageFromFile(file),
      content: content || buildMetadataMarkdown(file, sourceKey),
      source: sourceKey,
      category,
      metadataOnly: metadataOnly,
      fileId: fileId || undefined,
      mimeType: mimeType || undefined,
      size: size ?? undefined,
      urls: urls.length > 0 ? urls : undefined,
    };
  }

  function fileDedupeKey(item) {
    const id = item.fileId || "";
    return `${item.category}:${item.title}:${id}:${(item.content || "").slice(0, 160)}`;
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
    const seen = new Set();
    const sources = [
      ...(message.attachments || []),
      ...(message.files || []),
      ...(message.files_v2 || []),
    ];
    for (const att of sources) {
      const name = inferFileTitle(att, "attachment");
      const content = extractFileContent(att);
      if (content) {
        const key = `${name}:${content.slice(0, 80)}`;
        if (!seen.has(key)) {
          seen.add(key);
          excerpts.push({ name, content });
        }
      } else if (hasFileIdentity(att)) {
        const mimeType = inferFileMimeType(att);
        const note = `[Attachment: ${name}${mimeType ? " (" + mimeType + ")" : ""} — metadata only, no readable text]`;
        const key = `meta:${name}:${inferFileId(att) || ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          excerpts.push({ name, content: note });
        }
      }
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const blockBody = nestedText(
          block.text ||
          block.content ||
          block.source?.data ||
          block.document?.content
        );
        if (
          block.type &&
          block.type !== "text" &&
          block.type !== "thinking" &&
          block.type !== "redacted_thinking" &&
          blockBody.length > 80
        ) {
          const bName = block.title || block.name || block.type;
          const key = `block:${bName}:${blockBody.slice(0, 80)}`;
          if (!seen.has(key)) {
            seen.add(key);
            excerpts.push({ name: bName, content: blockBody });
          }
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
      csv: ".csv",
      xml: ".xml",
      yaml: ".yaml",
      yml: ".yml",
      toml: ".toml",
    };
    // Mime-type to extension mapping
    const mimeToExt = {
      "text/plain": ".txt",
      "text/markdown": ".md",
      "text/html": ".html",
      "text/css": ".css",
      "text/csv": ".csv",
      "text/xml": ".xml",
      "application/json": ".json",
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/gzip": ".gz",
      "application/xml": ".xml",
      "application/javascript": ".js",
      "application/typescript": ".ts",
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
      "image/avif": ".avif",
      "audio/mpeg": ".mp3",
      "audio/wav": ".wav",
      "audio/ogg": ".ogg",
      "video/mp4": ".mp4",
      "video/webm": ".webm",
    };
    const raw = String(language || "txt").toLowerCase().trim();
    // Check full mime-type first
    if (mimeToExt[raw]) {
      return mimeToExt[raw];
    }
    const key = raw.replace(/^.*\//, "").replace(/^\./, "");
    return languageToExt[key] || (key.startsWith(".") ? key : ".txt");
  }

  /**
   * Check if a title already ends with the given extension,
   * to avoid producing names like "diagram.png.png".
   */
  function titleHasExtension(title, ext) {
    return title.toLowerCase().endsWith(ext.toLowerCase());
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
    extractFileContent,
    nestedText,
    extractFileUrls,
    hasFileIdentity,
    buildMetadataMarkdown,
    inferFileTitle,
    inferFileId,
    inferFileMimeType,
    inferFileSize,
    categorizeMessageFile,
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
    titleHasExtension,
    getUniqueFileName,
    inferPastedTitle,
    buildExportDiagnostics,
    logExportDiagnostics,
  };
});
