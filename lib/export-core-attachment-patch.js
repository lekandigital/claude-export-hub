// Keeps Claude file cards exportable when they only contain metadata.
(function (root) {
  const base = root.CadExportCore;
  if (!base) return;

  function title(file, fallback) {
    return file?.title || file?.file_name || file?.filename || file?.name || fallback || "Untitled";
  }

  function fileId(file) {
    return file?.file_uuid || file?.file_id || file?.uuid || file?.id || null;
  }

  function nestedText(value) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) return value.map(nestedText).filter(Boolean).join("\n\n").trim();
    if (value && typeof value === "object") {
      return nestedText(
        value.text || value.content || value.extracted_content || value.extracted_text || value.markdown || value.data,
      );
    }
    return "";
  }

  function fileText(file) {
    return nestedText(
      file?.extracted_content ||
        file?.extracted_text ||
        file?.content ||
        file?.text ||
        file?.document?.text ||
        file?.document?.content ||
        file?.source?.text ||
        file?.source?.data,
    );
  }

  function hasIdentity(file) {
    return !!(title(file, "") || fileId(file) || file?.mime_type || file?.file_type || file?.type);
  }

  function metadataMarkdown(file, source) {
    const rows = [
      `# ${title(file, `${source}_file`)}`,
      "",
      "This file appeared in the chat, but Claude did not expose readable file text in the cached response.",
      "",
      `- Source: ${source}`,
    ];
    const id = fileId(file);
    const kind = file?.mime_type || file?.file_type || file?.type;
    const size = file?.size || file?.file_size || file?.size_bytes;
    if (id) rows.push(`- File ID: ${id}`);
    if (kind) rows.push(`- Type: ${kind}`);
    if (size != null) rows.push(`- Size: ${size}`);
    rows.push("");
    return rows.join("\n");
  }

  function categorize(file, source) {
    if (!file || typeof file !== "object") return null;
    const extracted = fileText(file);
    if (!extracted && !hasIdentity(file)) return null;

    let category = "attachments";
    if (source === "files_v2" || file.presented || file.is_presented) category = "presented-files";
    if (source === "files" || file.generated || file.is_generated) category = "generated-files";

    return {
      title: title(file, `${source}_file`),
      language: extracted ? file.language || file.file_type || file.mime_type || file.type || "txt" : "markdown",
      content: extracted || metadataMarkdown(file, source),
      source,
      category,
      metadataOnly: !extracted,
      fileId: fileId(file),
    };
  }

  function key(item) {
    return `${item.category}:${item.source || ""}:${item.title}:${item.fileId || ""}:${(item.content || "").slice(0, 100)}`;
  }

  function addUnique(list, item, seen) {
    if (!item) return;
    const k = key(item);
    if (seen.has(k)) return;
    seen.add(k);
    list.push(item);
  }

  function collectFilesFromMessage(message, messageIndex) {
    const items = [];
    const seen = new Set();
    for (const item of base.collectFilesFromMessage(message, messageIndex) || []) addUnique(items, item, seen);
    for (const [source, list] of Object.entries({ attachments: message.attachments, files: message.files, files_v2: message.files_v2 })) {
      if (!Array.isArray(list)) continue;
      for (const file of list) addUnique(items, { ...categorize(file, source), messageIndex }, seen);
    }
    return items;
  }

  function collectCategorizedItemsFromPayload(payload) {
    const out = { artifacts: [], attachments: [], presentedFiles: [], generatedFiles: [], pasted: [] };
    const seen = new Set();
    function add(bucket, item, messageIndex) {
      if (!item) return;
      const k = key(item);
      if (seen.has(k)) return;
      seen.add(k);
      bucket.push({ ...item, messageIndex });
    }

    for (const message of base.getActiveBranchMessages(payload)) {
      const index = message.index ?? 0;
      const text = base.getMessageText(message);
      for (const artifact of base.extractArtifacts(text)) add(out.artifacts, artifact, index);
      for (const item of collectFilesFromMessage(message, index)) {
        if (item.category === "presented-files") add(out.presentedFiles, item, index);
        else if (item.category === "generated-files") add(out.generatedFiles, item, index);
        else if (item.category === "attachments") add(out.attachments, item, index);
        else add(out.artifacts, item, index);
      }
      if ((message.sender === "human" || message.role === "user") && text.trim().length > 80) {
        const pastedKey = `pasted:${text.slice(0, 120)}`;
        if (!seen.has(pastedKey)) {
          seen.add(pastedKey);
          out.pasted.push({ title: base.inferPastedTitle(text, "human"), language: "markdown", content: text.trim(), messageIndex: index });
        }
      }
    }
    return out;
  }

  function getAttachmentExcerpts(message) {
    const excerpts = base.getAttachmentExcerpts(message) || [];
    const seen = new Set(excerpts.map((item) => `${item.name}:${item.content.slice(0, 80)}`));
    for (const file of [...(message.attachments || []), ...(message.files || []), ...(message.files_v2 || [])]) {
      const item = categorize(file, "attachments");
      if (!item) continue;
      const name = title(file, "attachment");
      const k = `${name}:${item.content.slice(0, 80)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      excerpts.push({ name, content: item.content });
    }
    return excerpts;
  }

  root.CadExportCore = { ...base, collectFilesFromMessage, collectCategorizedItemsFromPayload, getAttachmentExcerpts };
  if (typeof module === "object" && module.exports) module.exports = root.CadExportCore;
})(typeof globalThis !== "undefined" ? globalThis : this);
