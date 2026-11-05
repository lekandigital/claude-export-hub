# Claude Export Hub

Chrome extension for exporting Claude.ai conversations — transcripts, artifacts, pasted content, attachment excerpts, and visible thinking/status panels (toggleable per export) — as organized ZIP archives. All processing runs locally in your browser.

## ⚠ Maintenance notice

Claude Export Hub depends on the structure of Claude's web interface and API responses, both of which Anthropic changes frequently and without notice. **The extension requires ongoing updates to maintain full functionality.** If exports start returning empty results or missing content categories, check for an updated version of the extension. DOM selectors for status panels, API response shapes, and conversation payload structures are all subject to change.

## What it does

Claude Export Hub fetches conversation data from Claude's own API using your existing browser session, then packages selected content into downloadable ZIP files. No third-party servers are involved.

## Export modes

- **This chat** — export the conversation you are viewing
- **Pick chats** — search and select specific conversations from your history
- **All chats** — export your full conversation list (with confirmation)

Use the extension popup for all three modes. A floating in-page control on chat pages exports the current conversation quickly.

## Full archive (complete backup)

**All chats → "Full archive"** in the popup opens `archive.html`, which writes every chat straight into `Downloads/Claude Full Archive/` — no ZIP, no save dialogs:

```
Claude Full Archive/
  _index.md / _index.json       # every chat with per-category counts
  _conversations.json           # the chat list as the API returned it
  _status.json                  # live progress + recent log (rewritten every ~15 s)
  _projects/<name>/             # project.json, instructions.md, docs/, files/
  2026-05-21 Chat title [a1b2c3d4]/
    conversation.json           # raw API payload, every branch, thinking, tool calls
    transcript.md               # main branch, thinking + pasted text inline
    branches.md                 # edited/retried branches (when any)
    thinking.md                 # every thinking block
    pasted/                     # pasted text and text attachments
    uploads/                    # your files, original bytes (/files/{id}/contents or sandbox)
    outputs/                    # files Claude made (wiggle sandbox; text rebuilt from the chat if expired)
    tool-images/                # images returned inside tool results
    created-files/              # other create_file targets, rebuilt from the chat
    artifacts/                  # final version of each artifact
    manifest.json               # every file, how it was fetched, and anything that failed
```

How it works: API calls run inside a background claude.ai tab (same session as the site), files are written with `chrome.downloads`, and finished chats are remembered per folder so a rerun only redoes new or changed chats. Image previews (`.preview.webp`) are used only when an original is unavailable.

Incognito (temporary) chats never appear in Claude's chat lists. Recent ones can still be fetched by ID: add their links to the "Only these chats" box, or pass them as `extra`. Older ones are purged by Claude and return 404.

After the chats, two more passes run: every file in the account's file list (`/account/files`) that no chat folder already has is saved into that chat's `file-versions/` (earlier versions of rewritten files, files from deleted branches) or `_account-files/`.

### Using Claude's official data export as a map

The official export (Settings → Privacy → Export data) lists every chat and file but only names the files. Use it to tell the archiver where to look, then fold it in:

```bash
python3 -I scripts/hints-from-official-export.py "<unzipped export dir>"   # writes archive-hints.json (git-ignored)
# run the Full archive — it loads archive-hints.json automatically and also tries
# every hinted chat, file ID (/files/{id}/contents, then preview) and project by ID
python3 -I scripts/merge-official-export.py "$HOME/Downloads/Claude Full Archive" "<unzipped export dir>"
```

The merge step adds `_official-export-only/` (chats Claude no longer serves, rebuilt from the export), `_official-export/` (projects, memories, design chats, published artifacts, Claude Code cloud) and `_coverage.md`, which accounts for every chat, file, thinking block and pasted text in the export. `_hint-files.json` and `_account-files.json` record each file ID's outcome; runs limited to selected chats write `.selected.json` versions instead.

### Driving it from a script

Create `automation-token.txt` (git-ignored, 16+ random characters) in the extension folder and reload the extension. Then opening these URLs in Chrome runs commands (the token stops web pages from triggering anything):

```bash
T=$(cat automation-token.txt)
open -g "https://claude.ai/#ceh=$T&cmd=reload"                                   # reload the extension
open -g "https://claude.ai/#ceh=$T&cmd=archive"                                  # archive everything
open -g "https://claude.ai/#ceh=$T&cmd=archive&uuids=<id>,<id>&root=Test&force=1" # selected chats
open -g "https://claude.ai/#ceh=$T&cmd=archive&extra=<incognito id>,…"           # plus unlisted chats
```

Watch `Downloads/<root>/_status.json` for progress.

## Include options

Each export uses checkboxes:

- **Transcript** — full conversation as `chat.md` (on by default)
- **Artifacts** — Claude files and exportable payloads in `artifacts/`, plus related folders (on by default)
- **Pasted** — long pasted human messages in `pasted/` (on by default)
- **Visible thinking** — status/thinking panels Claude shows in the chat UI, in `thinking/` (on by default)

Export is blocked if no content type is selected.

### Visible thinking export

Claude Export Hub exports **only the thinking and status panels Claude visibly shows in the chat UI**, when available. This includes expandable sections such as:

- Extended thinking summaries (for example, “Synthesizing…”)
- Tool/status panels (for example, “Viewed files”, “Edited files”, “Presented files”)
- Progress labels (for example, “Retrieving complete source code”, “Diagnosing code block clipping issue”)

This does **not** recover hidden, omitted, encrypted, or redacted reasoning. If Claude or Anthropic's API marks thinking as redacted or omitted, Claude Export Hub will only include an official placeholder.

For bulk exports (Pick chats / All chats), thinking is extracted from the conversation payload, a **automatic per-chat page visit** that scrapes visible status panels from the rendered UI, and any prior cache for that chat. During bulk export with **Visible thinking** enabled, the extension briefly opens each selected chat in your Claude tab, expands status panels where possible, captures the visible text, then restores your original tab URL when finished. Live DOM capture without navigation applies when exporting the chat you currently have open (**This chat**).

## Folder layout

Each exported chat gets its own folder inside the ZIP:

```
Chat_Title_a1b2c3d4/
  _combined.txt           # all files in this chat merged into one context file
  _combined_deduped.txt   # same, with numbered paragraphs and duplicates removed
  chat.md                 # when Transcript is checked
  artifacts/              # <antArtifact> and artifact-like content blocks
    _combined.txt          # artifacts-only combined (when 2+ files)
    _combined_deduped.txt
  attachments/            # uploaded attachment excerpts with usable text
  presented-files/        # presented file payloads (for example files_v2)
  generated-files/        # generated/tool output files
  files_index.json        # manifest of exported files across the folders above
  pasted/                 # when Pasted is checked
  thinking/               # when Visible thinking is checked
    _combined.txt          # thinking-only combined (when 2+ files)
    _combined_deduped.txt
  skipped.txt             # optional notes when a category had nothing to export
_combined.txt             # (multi/all export) everything across all chats
_combined_deduped.txt
```

`_combined.txt` files flatten every file in a folder (and its subfolders) into a single text document with visual section markers — useful for sharing exported chat context. `_combined_deduped.txt` adds numbered paragraph IDs and replaces duplicate paragraphs with cross-references, reducing redundancy when the same content appears across multiple files. Combined files are only generated for folders containing 2 or more text files.

When visible thinking/status panels are exported, each block becomes a numbered markdown file under `thinking/`, plus a `thinking_index.json` manifest. Partial captures during an in-progress response are marked with a `_partial` suffix. Status panel files include `expanded` / `collapsed` metadata when detectable.

Attachment and content-block excerpts are also included **inline in `chat.md`** (quoted blocks), in addition to any standalone files saved under `attachments/`, `presented-files/`, or `generated-files/`.

## Privacy

- Processing is entirely local
- No data is sent to third-party servers
- Fetches only Claude's own API using your browser session cookies

## Known limitations

- Claude's UI and API can change without notice; exports may need updates
- Collapsed status panels may export title-only placeholders when body text is not rendered in the DOM
- Some DOM artifact cards or attachments may export as metadata-only placeholders if the API payload lacks both readable text and a safe download URL
- Visible thinking export captures what Claude shows in the UI, not hidden or encrypted reasoning
- Large bulk exports can take time; progress and cancel are available in the popup. Bulk exports with **Visible thinking** visit each chat in the browser (~3–5 seconds per chat) to capture status panels.
- Not affiliated with or endorsed by Anthropic

## Future features

- **Advanced context compression**: Implement smarter ways to compress context from generated combined files beyond simple paragraph-level deduplication. Future improvements could include semantic similarity deduplication, LLM-friendly summarization of repeated boilerplate, token-count-aware truncation, cross-chat deduplication, and structural compression.
- **Comprehensive attachment extraction**: Fully extract and parse text from document attachments (such as PDFs, Markdown, and text files) while leaving images and other non-text media assets unaltered.

## Troubleshooting

- **"Could not connect to Claude tab"** — After reloading the extension, refresh any open claude.ai tabs and try again. Bulk exports (Pick chats / All chats) need an open Claude tab; the extension will reconnect automatically when possible.
- **No thinking/ folder** — Uncheck/re-check **Visible thinking**, then re-export. For **Pick chats** / **All chats**, the extension visits each chat automatically to scrape status panels; keep a claude.ai tab open and allow the export to finish (the tab will flip through chats and restore your original URL at the end). Redacted or omitted thinking cannot be recovered.
- **No artifacts found** — Confirm **Artifacts** is checked. Newer chats may store files under `files`, `files_v2`, or content blocks instead of `<antArtifact>` tags. If Claude only shows a file card without extractable text in the API payload, the exporter can include metadata in `chat.md` but not a standalone file.
- **Export seems stuck** — Use Cancel in the popup; large All chats exports can take several minutes.
- **Debug counts** — Open the service worker console (`chrome://extensions` → Claude Export Hub → Service worker). Each export logs a one-line diagnostics summary with message, file, and status-panel counts.

## Development and fixture tests

Install dev dependencies:

```bash
npm install
```

Run all tests (synthetic payload tests + saved Claude HTML fixtures):

```bash
npm test
```

Run only fixture HTML tests:

```bash
npm run test:fixtures
```

Fixture pages live outside the repo by default at:

`/Users/lekan/Downloads/cchats_for_coding/split-pages`

Override with:

```bash
CAD_FIXTURE_ROOT=/path/to/split-pages npm run test:fixtures
```

Fixture folders are read-only reference HTML. Tests load each folder's `index.html` with JSDOM and verify status-panel extraction against the current Claude DOM shape.

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Google Chrome
3. Enable **Developer mode**
4. Click **Load unpacked** and select this directory

## Acknowledgements

This project began as a fork of [ashwanthkumar/claude-artifacts-downloader](https://github.com/ashwanthkumar/claude-artifacts-downloader), an MIT-licensed Chrome extension for downloading Claude artifacts from a conversation.

Claude Export Hub significantly extends that original idea with multi-chat export, selected-chat export, all-chat export, per-chat folder organization, transcript export, pasted-content export, visible thinking export, attachment/content-block handling, and a redesigned export workflow.

Portions of the original extension structure and artifact extraction approach are derived from `claude-artifacts-downloader`. The original MIT license and copyright notice are preserved in [LICENSE](LICENSE) and [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).

The project was also inspired by [hamelsmu/claudesave](https://github.com/hamelsmu/claudesave).

## License

[MIT License](LICENSE)
