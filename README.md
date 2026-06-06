# Claude Export Hub

Chrome extension for exporting Claude.ai conversations — transcripts, artifacts, pasted content, and attachment excerpts — as organized ZIP archives. All processing runs locally in your browser.

## What it does

Claude Export Hub fetches conversation data from Claude's own API using your existing browser session, then packages selected content into downloadable ZIP files. No third-party servers are involved.

## Export modes

- **This chat** — export the conversation you are viewing
- **Pick chats** — search and select specific conversations from your history
- **All chats** — export your full conversation list (with confirmation)

Use the extension popup for all three modes. A floating in-page control on chat pages exports the current conversation quickly.

## Include options

Each export uses checkboxes (all enabled by default):

- **Transcript** — full conversation as `chat.md`
- **Artifacts** — Claude `<antArtifact>` files in `artifacts/`
- **Pasted** — long pasted human messages in `pasted/`

Export is blocked if no content type is selected.

## Folder layout

Each exported chat gets its own folder inside the ZIP:

```
Chat_Title_a1b2c3d4/
  chat.md          # when Transcript is checked
  artifacts/       # when Artifacts is checked
  pasted/          # when Pasted is checked
  skipped.txt      # optional notes when a category had nothing to export
```

Attachment and content-block excerpts are included **inline in `chat.md`** (quoted blocks), not in a separate `attachments/` folder.

## Privacy

- Processing is entirely local
- No data is sent to third-party servers
- Fetches only Claude's own API using your browser session cookies

## Known limitations

- Claude's UI and API can change without notice; exports may need updates
- Attachments may appear as extracted text in `chat.md` depending on Claude's payload shape
- Large bulk exports can take time; progress and cancel are available in the popup
- Not affiliated with or endorsed by Anthropic

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Google Chrome
3. Enable **Developer mode**
4. Click **Load unpacked** and select this directory

## Acknowledgements

This project began as a fork of [ashwanthkumar/claude-artifacts-downloader](https://github.com/ashwanthkumar/claude-artifacts-downloader), an MIT-licensed Chrome extension for downloading Claude artifacts from a conversation.

Claude Export Hub significantly extends that original idea with multi-chat export, selected-chat export, all-chat export, per-chat folder organization, transcript export, pasted-content export, attachment/content-block handling, and a redesigned export workflow.

Portions of the original extension structure and artifact extraction approach are derived from `claude-artifacts-downloader`. The original MIT license and copyright notice are preserved in [LICENSE](LICENSE) and [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).

The project was also inspired by [hamelsmu/claudesave](https://github.com/hamelsmu/claudesave).

## License

[MIT License](LICENSE)
