const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

require("../lib/export-core.js");
require("../lib/export-core-attachment-patch.js");

const Core = globalThis.CadExportCore;
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

describe("attachment metadata patch", () => {
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

  it("extracts nested attachment text shapes", () => {
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
});
