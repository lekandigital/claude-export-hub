const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const Core = require("../lib/export-core.js");

const FIXTURE_ROOT =
  process.env.CAD_FIXTURE_ROOT ||
  "/Users/lekan/Downloads/cchats_for_coding/split-pages";

const FIXTURES = {
  projectAvailability:
    "project-availability-inquiry---claude-6_20_2026-82905-pm",
  shouldSend83021: "should-i-send-it-in-a-new-thre---claude-6_20_2026-83021-pm",
  shouldSend83059: "should-i-send-it-in-a-new-thre---claude-6_20_2026-83059-pm",
};

function loadFixture(folderName) {
  const htmlPath = path.join(FIXTURE_ROOT, folderName, "index.html");
  assert.ok(fs.existsSync(htmlPath), `fixture missing: ${htmlPath}`);
  const html = fs.readFileSync(htmlPath, "utf8");
  const dom = new JSDOM(html, { url: "https://claude.ai/chat/test-fixture" });
  return dom.window.document;
}

function titlesFromBlocks(blocks) {
  return blocks.map((block) => block.title);
}

describe("fixture DOM status/thinking extraction", () => {
  for (const [label, folder] of Object.entries(FIXTURES)) {
    it(`finds visible status panels in ${label}`, () => {
      const document = loadFixture(folder);
      const blocks = Core.collectVisibleStatusFromDom(document);
      assert.ok(
        blocks.length > 0,
        `expected status panels in ${folder}, got 0`,
      );
    });
  }

  it('detects Viewed/Edited/Presented labels in "should send" fixtures', () => {
    for (const folder of [FIXTURES.shouldSend83021, FIXTURES.shouldSend83059]) {
      const document = loadFixture(folder);
      const titles = titlesFromBlocks(
        Core.collectVisibleStatusFromDom(document),
      );
      const joined = titles.join("\n").toLowerCase();
      assert.match(joined, /viewed/);
      assert.match(joined, /edited/);
      assert.match(joined, /presented/);
    }
  });

  it('detects Synthesizing-style status in project availability fixture', () => {
    const document = loadFixture(FIXTURES.projectAvailability);
    const titles = titlesFromBlocks(
      Core.collectVisibleStatusFromDom(document),
    );
    const joined = titles.join("\n").toLowerCase();
    assert.match(joined, /synthesiz/);
  });

  it("captures expanded panel body text when present", () => {
    const document = loadFixture(FIXTURES.shouldSend83021);
    const blocks = Core.collectVisibleStatusFromDom(document);
    const expanded = blocks.find(
      (block) =>
        block.expanded &&
        block.title.includes("Retrieving complete source code"),
    );
    assert.ok(expanded, "expected expanded retrieving panel");
    assert.ok(
      expanded.content.length > 80,
      "expected non-trivial expanded body text",
    );
  });

  it("does not treat main assistant answer paragraphs as status panels", () => {
    const document = loadFixture(FIXTURES.shouldSend83021);
    const blocks = Core.collectVisibleStatusFromDom(document);
    const bad = blocks.find(
      (block) =>
        block.title.startsWith("Everything passes QA") ||
        block.title.startsWith("Now the edits"),
    );
    assert.equal(bad, undefined);
  });
});
