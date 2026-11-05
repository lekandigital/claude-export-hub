const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, VirtualConsole } = require("jsdom");
const { createSwEnv } = require("./harness/sw-env.js");

const QUIET = { log() {}, warn() {}, error() {}, debug() {} };
const ROOT_UUID = "00000000-0000-4000-8000-000000000000";
const UUID = "11111111-1111-4111-8111-111111111111";

function roleShapedPayload() {
  return {
    uuid: UUID,
    name: "Real Chat",
    messages: [
      {
        uuid: "a",
        parent_message_uuid: ROOT_UUID,
        role: "user",
        created_at: "2024-01-01T00:00:00Z",
        content: [{ type: "text", text: "Long paste:\n" + "L".repeat(300) }],
        attachments: [{ file_name: "spec.txt", extracted_content: "spec body" }],
      },
      {
        uuid: "b",
        parent_message_uuid: "a",
        role: "assistant",
        created_at: "2024-01-02T00:00:00Z",
        content: [
          {
            type: "text",
            text:
              'Result:\n<antArtifact title="app.py" language="python">print("hi")</antArtifact>',
          },
          { type: "thinking", thinking: "internal reasoning" },
        ],
        files_v2: [{ file_name: "out.csv", extracted_content: "a,b\n1,2" }],
      },
    ],
  };
}

async function buildZip(env, payload) {
  const JSZip = env.get("JSZip");
  const zip = new JSZip();
  const prefix = env.get("buildChatFolderPrefix")(payload);
  const thinking = env.get("CadExportCore").collectThinkingFromPayload(payload);
  const result = await env.get("writeStructuredChatToZip")(
    zip,
    payload,
    { transcript: true, artifacts: true, pasted: true, thinking: true },
    prefix,
    thinking,
  );
  await env.get("writeCombinedFilesRecursive")(zip);
  const names = [];
  zip.forEach((p, e) => {
    if (!e.dir) names.push(p);
  });
  return { zip, prefix, result, names: names.sort() };
}

describe("export pipeline (service worker in a VM)", () => {
  it("writes every content category for a role-shaped payload", async () => {
    const env = createSwEnv({ console: QUIET });
    const { prefix, result, names } = await buildZip(env, roleShapedPayload());

    assert.equal(result.skipped.length, 0, "nothing should be skipped");
    for (const expected of [
      `${prefix}chat.md`,
      `${prefix}files_index.json`,
      `${prefix}artifacts/2_app.py`,
      `${prefix}attachments/1_spec.txt`,
      `${prefix}presented-files/2_out.csv`,
      `${prefix}thinking/thinking_index.json`,
    ]) {
      assert.ok(names.includes(expected), `missing ${expected} in:\n${names.join("\n")}`);
    }
    assert.ok(names.some((n) => n.startsWith(`${prefix}pasted/`)), "no pasted/ file");
  });

  it("labels the transcript with Human and Assistant, not all Assistant", async () => {
    const env = createSwEnv({ console: QUIET });
    const { zip, prefix } = await buildZip(env, roleShapedPayload());
    const md = await zip.file(`${prefix}chat.md`).async("string");

    assert.match(md, /### Human/, "transcript lost the Human attribution");
    assert.match(md, /### Assistant/);
    assert.equal((md.match(/### Assistant/g) || []).length, 1);
  });

  it("never produces doubled file extensions", async () => {
    const env = createSwEnv({ console: QUIET });
    const { names } = await buildZip(env, roleShapedPayload());
    for (const n of names) {
      assert.doesNotMatch(n, /\.(\w+)\.\1$/i, `doubled extension in ${n}`);
    }
  });

  it("still exports a flat payload that carries no tree linkage", async () => {
    const env = createSwEnv({ console: QUIET });
    const flat = roleShapedPayload();
    for (const m of flat.messages) delete m.parent_message_uuid;

    const { zip, prefix, result } = await buildZip(env, flat);
    const md = await zip.file(`${prefix}chat.md`).async("string");
    assert.ok(!result.skipped.some((s) => s.type === "transcript"));
    assert.match(md, /### Human/);
  });
});

/**
 * Regression guard for the class of bug where code injected with
 * world: "MAIN" referenced a content-script global (CadExportCore).
 * The injected function is executed in a real page scope that has no
 * extension globals, so any outer-scope reference throws ReferenceError.
 */
describe("MAIN-world injected bridge", () => {
  function capturedInjectFunc() {
    const all = [];
    const env = createSwEnv({
      console: QUIET,
      onTabMessage: (_tabId, msg) =>
        msg.action === "ping"
          ? { ok: true }
          : { payload: null, error: "test-sentinel" },
      onExecuteScript: (spec) => {
        all.push(spec);
        return [{ result: undefined }];
      },
    });
    // ensureContentScript() also injects; we want the MAIN-world one.
    return { env, get: () => all.find((s) => s.world === "MAIN"), all };
  }

  async function runInPageWorld(spec, { orgs, conversation }) {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://claude.ai/chat/x",
      virtualConsole: new VirtualConsole(),
      // gives the window its own eval, so the injected function is compiled
      // in the page global exactly as chrome.scripting world:"MAIN" does
      runScripts: "outside-only",
    });
    const win = dom.window;

    win.fetch = async (path) => {
      if (String(path).startsWith("/api/organizations?") || path === "/api/organizations") {
        return { ok: true, status: 200, json: async () => orgs };
      }
      if (String(path).includes("/chat_conversations/")) {
        return { ok: true, status: 200, json: async () => conversation };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const events = [];
    win.document.addEventListener(`cad-payload-${UUID}`, (e) => events.push(e.detail));

    // Evaluating in the window scope means free identifiers must resolve
    // against the page global, exactly as in the real MAIN world.
    const fn = win.eval(`(${spec.func.toString()})`);
    await fn(...spec.args);
    return events;
  }

  it("runs without touching any extension-world global", async () => {
    const { env, get } = capturedInjectFunc();
    await env.get("fetchPayloadViaPageEventBridge")(1, UUID);
    const spec = get();
    assert.ok(spec, "no script was injected");
    assert.equal(spec.world, "MAIN");

    const events = await runInPageWorld(spec, {
      orgs: [{ uuid: "org-1", capabilities: ["chat"] }],
      conversation: {
        uuid: UUID,
        name: "Bridged",
        chat_messages: [
          { uuid: "a", parent_message_uuid: ROOT_UUID, sender: "human", text: "hi" },
        ],
      },
    });

    assert.equal(events.length, 1, "bridge dispatched no payload event");
    assert.ok(events[0].payload, `bridge errored: ${events[0].error}`);
    assert.equal(events[0].messageCount, 1);
  });

  it("dispatches a payload the service worker can normalize", async () => {
    const { env, get } = capturedInjectFunc();
    await env.get("fetchPayloadViaPageEventBridge")(1, UUID);

    const events = await runInPageWorld(get(), {
      orgs: [{ uuid: "org-1", capabilities: ["chat"] }],
      // messages-only, role-keyed: the shape the bridge must hand back raw
      conversation: {
        uuid: UUID,
        name: "Bridged",
        messages: [
          { uuid: "a", parent_message_uuid: ROOT_UUID, role: "user", text: "hi" },
        ],
      },
    });

    const raw = events[0].payload;
    const Core = env.get("CadExportCore");
    assert.ok(Core.isStorableChatPayload(raw), "SW cannot store the bridged payload");
    const normalized = Core.normalizeChatPayload(raw);
    assert.equal(normalized.chat_messages.length, 1);
    assert.equal(normalized.chat_messages[0].sender, "human");
  });
});
