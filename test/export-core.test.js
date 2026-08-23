const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../lib/export-core.js");

const SAMPLE_UUID = "11111111-1111-4111-8111-111111111111";
const ROOT_UUID = "00000000-0000-4000-8000-000000000000";

function makePayload(messages, extra = {}) {
  return {
    uuid: SAMPLE_UUID,
    name: "Test Chat",
    current_leaf_message_uuid: messages[messages.length - 1]?.uuid,
    chat_messages: messages,
    ...extra,
  };
}

describe("normalizeChatPayload", () => {
  it("accepts payload.chat_messages", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "human",
        text: "hi",
      },
    ]);
    const normalized = Core.normalizeChatPayload(payload);
    assert.equal(normalized.uuid, SAMPLE_UUID);
    assert.equal(normalized.chat_messages.length, 1);
  });

  it("accepts payload.messages", () => {
    const normalized = Core.normalizeChatPayload({
      uuid: SAMPLE_UUID,
      messages: [
        {
          uuid: "a",
          parent_message_uuid: ROOT_UUID,
          sender: "human",
          text: "hi",
        },
      ],
    });
    assert.ok(normalized);
    assert.equal(normalized.chat_messages.length, 1);
  });

  it("accepts payload.conversation.chat_messages", () => {
    const normalized = Core.normalizeChatPayload({
      conversation: {
        uuid: SAMPLE_UUID,
        name: "Nested",
        chat_messages: [
          {
            uuid: "a",
            parent_message_uuid: ROOT_UUID,
            sender: "assistant",
            text: "hello",
          },
        ],
      },
    });
    assert.equal(normalized.name, "Nested");
    assert.equal(normalized.chat_messages.length, 1);
  });

  it("accepts payload.data.chat_messages", () => {
    const normalized = Core.normalizeChatPayload({
      data: {
        uuid: SAMPLE_UUID,
        chat_messages: [
          {
            uuid: "a",
            parent_message_uuid: ROOT_UUID,
            sender: "human",
            text: "nested data",
          },
        ],
      },
    });
    assert.ok(normalized);
  });
});

describe("artifact and file extraction", () => {
  it("extracts old antArtifact tags", () => {
    const text =
      'Here is code <antArtifact title="Widget" language="javascript">console.log("x")</antArtifact>';
    const artifacts = Core.extractArtifacts(text);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].title, "Widget");
    assert.match(artifacts[0].content, /console\.log/);
  });

  it("extracts message.files and message.files_v2", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "assistant",
        index: 0,
        files: [
          {
            file_name: "build.py",
            content: "print('generated')\n" + "x".repeat(100),
            generated: true,
          },
        ],
        files_v2: [
          {
            filename: "report.pdf",
            extracted_content: "PDF summary text " + "y".repeat(100),
            presented: true,
          },
        ],
      },
    ]);

    const result = Core.collectCategorizedItemsFromPayload(payload);
    assert.equal(result.generatedFiles.length, 1);
    assert.equal(result.presentedFiles.length, 1);
    assert.match(result.generatedFiles[0].content, /generated/);
  });

  it("extracts message.attachments", () => {
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
  });

  it("extracts non-text content blocks", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "assistant",
        index: 0,
        content: [
          {
            type: "document",
            title: "Spec",
            content: "Document body " + "d".repeat(100),
          },
          {
            type: "tool_result",
            name: "run",
            result: "Tool output " + "t".repeat(100),
          },
        ],
      },
    ]);

    const result = Core.collectCategorizedItemsFromPayload(payload);
    assert.ok(result.artifacts.some((item) => item.title === "Spec"));
    assert.ok(result.generatedFiles.some((item) => item.source === "content:tool_result"));
  });

  it("dedupes antArtifact against content block files", () => {
    const body = `<antArtifact title="Dup" language="txt">same content here</antArtifact>`;
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "assistant",
        index: 0,
        text: body,
        content: [{ type: "text", text: body }],
      },
    ]);

    const result = Core.collectCategorizedItemsFromPayload(payload);
    assert.equal(result.artifacts.length, 1);
  });
});

describe("thinking payload extraction", () => {
  it("captures thinking blocks and omitted placeholders", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "assistant",
        index: 0,
        content: [
          {
            type: "thinking",
            title: "Planning",
            thinking: "Visible plan details",
          },
          {
            type: "thinking",
            display: "omitted",
          },
        ],
      },
    ]);

    const items = Core.collectThinkingFromPayload(payload);
    assert.equal(items.length, 2);
    assert.ok(items.some((item) => item.content.includes("Visible plan")));
    assert.ok(items.some((item) => item.content.includes("[Thinking omitted]")));
  });

  it("captures redacted_thinking placeholders only", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "assistant",
        index: 0,
        content: [
          {
            type: "redacted_thinking",
            data: "encrypted",
          },
        ],
      },
    ]);

    const items = Core.collectThinkingFromPayload(payload);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "redacted_thinking");
    assert.match(items[0].content, /not available/);
  });
});

describe("buildExportDiagnostics", () => {
  it("reports counts and skipped categories", () => {
    const payload = makePayload([
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        sender: "human",
        text: "short",
      },
    ]);

    const diagnostics = Core.buildExportDiagnostics(payload, { domBlocks: [] });
    assert.equal(diagnostics.messages, 1);
    assert.ok(diagnostics.skipped.some((item) => item.category === "files"));
    assert.ok(diagnostics.skipped.some((item) => item.category === "thinking"));
  });
});

describe("role-shaped payloads", () => {
  it("backfills sender from role when tree linkage is present", () => {
    const normalized = Core.normalizeChatPayload({
      uuid: SAMPLE_UUID,
      name: "Role Chat",
      messages: [
        {
          uuid: "a",
          parent_message_uuid: ROOT_UUID,
          role: "user",
          content: [{ type: "text", text: "hello" }],
          created_at: "2024-01-01T00:00:00Z",
        },
        {
          uuid: "b",
          parent_message_uuid: "a",
          role: "assistant",
          content: [{ type: "text", text: "hi back" }],
          created_at: "2024-01-02T00:00:00Z",
        },
      ],
    });

    assert.ok(normalized);
    assert.deepEqual(
      normalized.chat_messages.map((m) => m.sender),
      ["human", "assistant"],
    );
    // original role is preserved
    assert.deepEqual(
      normalized.chat_messages.map((m) => m.role),
      ["user", "assistant"],
    );
  });

  it("resolves the active branch in order for role-shaped payloads", () => {
    const payload = {
      uuid: SAMPLE_UUID,
      messages: [
        {
          uuid: "a",
          parent_message_uuid: ROOT_UUID,
          role: "user",
          content: [{ type: "text", text: "q" }],
          created_at: "2024-01-01T00:00:00Z",
        },
        {
          uuid: "b",
          parent_message_uuid: "a",
          role: "assistant",
          content: [{ type: "text", text: "a" }],
          created_at: "2024-01-02T00:00:00Z",
        },
      ],
    };

    const branch = Core.getActiveBranchMessages(payload);
    assert.equal(branch.length, 2);
    assert.deepEqual(
      branch.map((m) => m.sender),
      ["human", "assistant"],
    );
  });

  it("falls back to array order when no message carries tree linkage", () => {
    const payload = {
      uuid: SAMPLE_UUID,
      messages: [
        { uuid: "a", role: "user", content: [{ type: "text", text: "one" }] },
        { uuid: "b", role: "assistant", content: [{ type: "text", text: "two" }] },
        { uuid: "c", role: "user", content: [{ type: "text", text: "three" }] },
      ],
    };

    const branch = Core.getActiveBranchMessages(payload);
    assert.equal(branch.length, 3);
    assert.deepEqual(
      branch.map((m) => m.uuid),
      ["a", "b", "c"],
    );
  });

  it("still returns [] when linkage exists but no root resolves", () => {
    const payload = {
      uuid: SAMPLE_UUID,
      messages: [
        // parent points at a message that is not in the payload, and no root
        { uuid: "a", parent_message_uuid: "missing", role: "user", text: "x" },
      ],
    };

    assert.deepEqual(Core.getActiveBranchMessages(payload), []);
  });

  it("collects pasted content from role-shaped human messages", () => {
    const long = "p".repeat(200);
    const payload = {
      uuid: SAMPLE_UUID,
      messages: [
        {
          uuid: "a",
          parent_message_uuid: ROOT_UUID,
          role: "user",
          content: [{ type: "text", text: long }],
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    };

    const items = Core.collectCategorizedItemsFromPayload(payload);
    assert.equal(items.pasted.length, 1);
    assert.ok(items.pasted[0].content.includes("p"));
  });

  it("collects thinking from role-shaped assistant messages", () => {
    const payload = {
      uuid: SAMPLE_UUID,
      messages: [
        {
          uuid: "a",
          parent_message_uuid: ROOT_UUID,
          role: "assistant",
          content: [
            { type: "thinking", thinking: "working through it" },
            { type: "text", text: "answer" },
          ],
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    };

    const thinking = Core.collectThinkingFromPayload(payload);
    assert.equal(thinking.length, 1);
  });

  it("never overwrites an explicit sender with an inconsistent role", () => {
    const normalized = Core.normalizeChatPayload({
      uuid: SAMPLE_UUID,
      messages: [
        {
          uuid: "a",
          parent_message_uuid: ROOT_UUID,
          sender: "assistant",
          role: "user",
          text: "x",
        },
      ],
    });

    assert.equal(normalized.chat_messages[0].sender, "assistant");
  });

  it("reports a specific diagnostic when the branch resolves to zero", () => {
    const payload = {
      uuid: SAMPLE_UUID,
      messages: [
        { uuid: "a", parent_message_uuid: "missing", role: "user", text: "x" },
      ],
    };

    const diagnostics = Core.buildExportDiagnostics(payload, { domBlocks: [] });
    assert.equal(diagnostics.messages, 0);
    const transcriptSkip = diagnostics.skipped.find(
      (item) => item.category === "transcript",
    );
    assert.ok(transcriptSkip);
    assert.match(transcriptSkip.reason, /active branch resolved to 0/);
  });
});
