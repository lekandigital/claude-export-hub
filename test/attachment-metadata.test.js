const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../lib/export-core.js");

const SAMPLE_UUID = "11111111-1111-4111-8111-111111111111";
const ROOT_UUID = "00000000-0000-4000-8000-000000000000";

function makePayload(messages) {
  return {
    uuid: SAMPLE_UUID,
    name: "Attachment Test",
    current_leaf_message_uuid: messages[messages.length - 1]?.uuid,
    chat_messages: messages,
  };
}

describe("attachment metadata handling", () => {
  it("keeps metadata-only attachments instead of dropping them", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "human",
        index: 0,
        attachments: [
          {
            file_name: "diagram.png",
            file_uuid: "file_123",
            mime_type: "image/png",
            size: 2048,
          },
        ],
      },
    ]);

    const result = Core.collectCategorizedItemsFromPayload(payload);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].title, "diagram.png");
    assert.equal(result.attachments[0].metadataOnly, true);
    assert.equal(result.attachments[0].language, "markdown");
    assert.match(result.attachments[0].content, /file_123/);
    assert.match(result.attachments[0].content, /image\/png/);
  });

  it("preserves fileId on metadata-only attachments", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "human",
        index: 0,
        attachments: [
          {
            file_name: "doc.pdf",
            file_uuid: "uuid_abc",
            mime_type: "application/pdf",
          },
        ],
      },
    ]);

    const result = Core.collectCategorizedItemsFromPayload(payload);
    assert.equal(result.attachments[0].fileId, "uuid_abc");
    assert.equal(result.attachments[0].mimeType, "application/pdf");
  });

  it("extracts nested document.text attachment content", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "human",
        index: 0,
        attachments: [
          {
            file_name: "nested.md",
            document: { text: "Nested attachment text " + "n".repeat(100) },
          },
        ],
      },
    ]);

    const result = Core.collectCategorizedItemsFromPayload(payload);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].metadataOnly, false);
    assert.match(result.attachments[0].content, /Nested attachment text/);
  });

  it("extracts nested source.data attachment content", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "human",
        index: 0,
        attachments: [
          {
            file_name: "data_file.txt",
            source: { data: "Source data content " + "s".repeat(100) },
          },
        ],
      },
    ]);

    const result = Core.collectCategorizedItemsFromPayload(payload);
    assert.equal(result.attachments.length, 1);
    assert.match(result.attachments[0].content, /Source data content/);
  });

  it("existing extracted_content attachment still works", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "human",
        index: 0,
        attachments: [
          {
            file_name: "notes.txt",
            extracted_content: "User attachment " + "z".repeat(100),
          },
        ],
      },
    ]);

    const result = Core.collectCategorizedItemsFromPayload(payload);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].title, "notes.txt");
    assert.equal(result.attachments[0].metadataOnly, false);
    assert.match(result.attachments[0].content, /User attachment/);
  });

  it("URL-backed attachment produces urls array", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "human",
        index: 0,
        attachments: [
          {
            file_name: "report.pdf",
            file_uuid: "file_url_test",
            mime_type: "application/pdf",
            download_url: "https://claude.ai/api/files/report.pdf",
          },
        ],
      },
    ]);

    const result = Core.collectCategorizedItemsFromPayload(payload);
    assert.equal(result.attachments.length, 1);
    assert.ok(Array.isArray(result.attachments[0].urls));
    assert.equal(result.attachments[0].urls.length, 1);
    assert.equal(result.attachments[0].urls[0], "https://claude.ai/api/files/report.pdf");
  });
});

describe("file extension handling", () => {
  it("maps mime types correctly", () => {
    assert.equal(Core.getFileExtension("image/png"), ".png");
    assert.equal(Core.getFileExtension("image/jpeg"), ".jpg");
    assert.equal(Core.getFileExtension("application/pdf"), ".pdf");
    assert.equal(Core.getFileExtension("application/json"), ".json");
    assert.equal(Core.getFileExtension("text/plain"), ".txt");
    assert.equal(Core.getFileExtension("text/markdown"), ".md");
    assert.equal(Core.getFileExtension("text/csv"), ".csv");
    assert.equal(Core.getFileExtension("image/webp"), ".webp");
    assert.equal(Core.getFileExtension("image/gif"), ".gif");
    assert.equal(Core.getFileExtension("application/zip"), ".zip");
  });

  it("avoids duplicate extensions", () => {
    assert.equal(Core.titleHasExtension("diagram.png", ".png"), true);
    assert.equal(Core.titleHasExtension("diagram.PNG", ".png"), true);
    assert.equal(Core.titleHasExtension("report.pdf", ".pdf"), true);
    assert.equal(Core.titleHasExtension("notes.txt", ".md"), false);
    assert.equal(Core.titleHasExtension("data", ".txt"), false);
  });
});

describe("nestedText extraction", () => {
  it("handles string values", () => {
    assert.equal(Core.nestedText("hello world"), "hello world");
  });

  it("handles arrays of strings", () => {
    const result = Core.nestedText(["first", "second"]);
    assert.match(result, /first/);
    assert.match(result, /second/);
  });

  it("handles nested objects with text key", () => {
    assert.equal(Core.nestedText({ text: "inner text" }), "inner text");
  });

  it("handles nested objects with content key", () => {
    assert.equal(Core.nestedText({ content: "inner content" }), "inner content");
  });

  it("handles deeply nested structures", () => {
    const result = Core.nestedText([{ text: "a" }, { content: "b" }]);
    assert.match(result, /a/);
    assert.match(result, /b/);
  });

  it("returns empty string for non-text values", () => {
    assert.equal(Core.nestedText(null), "");
    assert.equal(Core.nestedText(undefined), "");
    assert.equal(Core.nestedText(42), "");
    assert.equal(Core.nestedText("   "), "");
  });
});

describe("attachment excerpts", () => {
  it("includes metadata-only notes in attachment excerpts", () => {
    const message = {
      sender: "human",
      attachments: [
        {
          file_name: "image.png",
          file_uuid: "uuid_img",
          mime_type: "image/png",
        },
      ],
    };

    const excerpts = Core.getAttachmentExcerpts(message);
    assert.equal(excerpts.length, 1);
    assert.equal(excerpts[0].name, "image.png");
    assert.match(excerpts[0].content, /metadata only/);
  });

  it("includes text content excerpts normally", () => {
    const longContent = "Readable attachment content " + "x".repeat(200);
    const message = {
      sender: "human",
      attachments: [
        {
          file_name: "readme.md",
          extracted_content: longContent,
        },
      ],
    };

    const excerpts = Core.getAttachmentExcerpts(message);
    assert.equal(excerpts.length, 1);
    assert.equal(excerpts[0].name, "readme.md");
    assert.match(excerpts[0].content, /Readable attachment content/);
  });
});

describe("buildMetadataMarkdown", () => {
  it("produces markdown with all metadata fields", () => {
    const file = {
      file_name: "chart.png",
      file_uuid: "file_999",
      mime_type: "image/png",
      size: 4096,
      created_at: "2025-01-01T00:00:00Z",
      download_url: "https://claude.ai/api/files/chart.png",
    };

    const md = Core.buildMetadataMarkdown(file, "attachments");
    assert.match(md, /# chart\.png/);
    assert.match(md, /Source: attachments/);
    assert.match(md, /File ID: file_999/);
    assert.match(md, /Type: image\/png/);
    assert.match(md, /Size: 4096/);
    assert.match(md, /Created: 2025-01-01/);
    assert.match(md, /URL: https:\/\/claude\.ai/);
  });
});
