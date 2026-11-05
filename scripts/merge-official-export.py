#!/usr/bin/env python3
"""Fold Claude's official data export into a Full archive folder.

Run after the Full archive (with archive-hints.json) has finished:

    python3 -I scripts/merge-official-export.py "<Downloads/Claude Full Archive>" <extracted export dir>

It adds:
  _official-export-only/   chats Claude no longer serves (purged incognito or
                           deleted), rebuilt from the official export
  _official-export/        the export's other parts (projects, memories,
                           design chats, published artifacts, Claude Code cloud)
  _coverage.md             every chat, file, thinking block and pasted text in
                           the official export, and where the archive has it
"""
import collections
import glob
import json
import os
import re
import shutil
import sys

archive_root, export_dir = sys.argv[1], sys.argv[2]
conversations_path = next(iter(glob.glob(os.path.join(export_dir, "**", "conversations.json"), recursive=True)))
official = json.load(open(conversations_path))


def safe(name, fallback="Untitled", limit=70):
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*~]', "_", name or "").strip().strip(".")
    return (name[:limit].strip() or fallback)


def fence(text):
    ticks = "`" * max(3, max((len(m) for m in re.findall(r"`+", text)), default=0) + 1)
    return f"{ticks}\n{text}\n{ticks}"


def thinking_text(block):
    return block.get("thinking") or "\n\n".join(s.get("summary", "") for s in block.get("summaries") or [])


def has_content(conv):
    return any(m.get("text") or m.get("content") or m.get("files") or m.get("attachments") for m in conv["chat_messages"])


# What the archive already holds, from the per-chat manifests.
archived = {}
saved_file_uuids = set()
for manifest_path in glob.glob(os.path.join(archive_root, "**", "manifest.json"), recursive=True):
    if "/_official-export" in manifest_path:
        continue
    manifest = json.load(open(manifest_path))
    folder = os.path.dirname(manifest_path)
    archived[manifest["uuid"]] = folder
    saved_file_uuids.update(f["file_uuid"] for f in manifest["files"] if f.get("ok") and f.get("file_uuid"))
for extra_index in ("_account-files", "_hint-files"):
    # A later selected-chat run (.selected.json) overrides the full run's entries.
    entries = {}
    for suffix in (".json", ".selected.json"):
        path = os.path.join(archive_root, extra_index + suffix)
        if os.path.exists(path):
            entries.update({e["file_uuid"]: e for e in json.load(open(path))})
    saved_file_uuids.update(u for u, e in entries.items() if e.get("status", "").startswith("saved"))

# 1. Official-only chats.
only_dir = os.path.join(archive_root, "_official-export-only")
empty, written = [], []
for conv in official:
    if conv["uuid"] in archived:
        continue
    if not has_content(conv):
        empty.append({"uuid": conv["uuid"], "created_at": conv.get("created_at"), "messages": len(conv["chat_messages"])})
        continue
    folder = os.path.join(only_dir, f"{(conv.get('created_at') or '')[:10]} {safe(conv.get('name'))} [{conv['uuid'][:8]}]")
    os.makedirs(os.path.join(folder, "pasted"), exist_ok=True)
    json.dump(conv, open(os.path.join(folder, "conversation.json"), "w"), indent=2, ensure_ascii=False)
    lines = [f"# {conv.get('name') or 'Untitled'}", "",
             "> Rebuilt from Claude's official data export: this chat is no longer available from claude.ai,",
             "> so uploaded/generated files are names only and there is no live copy to compare against.", "",
             f"- Created: {conv.get('created_at', '')[:16].replace('T', ' ')}", ""]
    thinking, pasted_n = [], 0
    for i, m in enumerate(conv["chat_messages"], 1):
        who = "You" if m["sender"] == "human" else "Claude"
        lines += ["---", "", f"## {i} · {who} · {m.get('created_at', '')[:16].replace('T', ' ')}", ""]
        blocks = m.get("content") or ([{"type": "text", "text": m["text"]}] if m.get("text") else [])
        for b in blocks:
            if b.get("type") == "text":
                lines += [b.get("text", ""), ""]
            elif b.get("type") == "thinking":
                t = thinking_text(b)
                thinking.append(f"## Message {i}\n\n{t}")
                lines += ["<details><summary>Thinking</summary>", "", t, "", "</details>", ""]
            elif b.get("type") == "tool_use":
                lines += [f"**Tool call · `{b.get('name')}`**", "", fence(json.dumps(b.get("input") or {}, indent=2, ensure_ascii=False)), ""]
            elif b.get("type") == "tool_result":
                content = b.get("content")
                text = "\n".join(x.get("text", "") for x in content if isinstance(x, dict)) if isinstance(content, list) else str(content or "")
                lines += [f"**Tool result · `{b.get('name', '')}`**", "", fence(text[:4000]), ""]
        for a in m.get("attachments") or []:
            pasted_n += 1
            name = f"{pasted_n:02d} {safe(a.get('file_name') or 'pasted', 'pasted', 60)}"
            if not os.path.splitext(name)[1]:
                name += ".txt"
            open(os.path.join(folder, "pasted", name), "w").write(a.get("extracted_content") or "")
            lines += [f"**Pasted:** pasted/{name}", ""]
        for f in m.get("files") or []:
            lines += [f"**File (name only in the official export):** {f.get('file_name') or f.get('file_uuid')}", ""]
    open(os.path.join(folder, "transcript.md"), "w").write("\n".join(lines))
    if thinking:
        open(os.path.join(folder, "thinking.md"), "w").write("\n\n---\n\n".join(thinking))
    if not pasted_n:
        os.rmdir(os.path.join(folder, "pasted"))
    written.append(conv)
if empty:
    os.makedirs(only_dir, exist_ok=True)
    json.dump(empty, open(os.path.join(only_dir, "_empty-chats.json"), "w"), indent=2)

# 1b. Live chats: keep the export's copy too. claude.ai's API omits some tool
# detail the export has (page text of web results, injected system notes,
# document references, some tool inputs), so each chat folder holds both and
# official-export-extras.md lists what only the export has, message by message.
def result_texts(content):
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [t for x in content for t in result_texts(x)]
    if isinstance(content, dict):
        own = [content["text"]] if isinstance(content.get("text"), str) else []
        return own + (result_texts(content.get("content")) if content.get("content") else [])
    return []


extras_total = collections.Counter()
for conv in official:
    folder = archived.get(conv["uuid"])
    if not folder:
        continue
    json.dump(conv, open(os.path.join(folder, "conversation.official-export.json"), "w"), indent=2, ensure_ascii=False)
    live = {m["uuid"]: m for m in json.load(open(os.path.join(folder, "conversation.json")))["chat_messages"]}
    sections = []
    for om in conv["chat_messages"]:
        am = live.get(om["uuid"])
        live_blocks = (am or {}).get("content") or []
        live_results = collections.Counter(t for b in live_blocks if b.get("type") == "tool_result" for t in result_texts(b.get("content")))
        parts = []
        for b in om.get("content") or []:
            t = b.get("type")
            if t == "tool_result":
                for text in result_texts(b.get("content")):
                    if live_results[text] > 0:
                        live_results[text] -= 1
                    elif text.strip():
                        parts.append(f"**Tool result text · `{b.get('name') or ''}`**\n\n{fence(text)}")
                        extras_total["tool result text"] += 1
            elif t == "tool_use" and not any(x.get("type") == "tool_use" and x.get("input") == b.get("input") for x in live_blocks):
                parts.append(f"**Tool call · `{b.get('name')}`**\n\n{fence(json.dumps(b.get('input') or {}, indent=2, ensure_ascii=False))}")
                extras_total["tool call / input"] += 1
            elif t == "injected_prompt_block" and not any(x.get("prompt") == b.get("prompt") for x in live_blocks):
                parts.append(f"**Injected system note · {b.get('injection_source') or ''}**\n\n{fence(b.get('prompt') or '')}")
                extras_total["injected system note"] += 1
            elif t == "document" and not any(x.get("file_uuid") == b.get("file_uuid") for x in live_blocks):
                parts.append(f"**Document reference:** {b.get('title')} (file {b.get('file_uuid')})")
                extras_total["document reference"] += 1
            elif t in ("text", "thinking") and am is None and (b.get("text") or b.get("thinking") or "").strip():
                parts.append(fence(b.get("text") or b.get("thinking")))
                extras_total[t] += 1
        if parts:
            who = "You" if om["sender"] == "human" else "Claude"
            sections.append(f"## {who} · {om.get('created_at', '')[:16].replace('T', ' ')} · message {om['uuid'][:8]}\n\n" + "\n\n".join(parts))
    extras_path = os.path.join(folder, "official-export-extras.md")
    if sections:
        header = (f"# Only in the official export — {conv.get('name') or 'Untitled'}\n\n"
                  "claude.ai's API leaves these details out of the live copy (conversation.json); "
                  "they come from conversation.official-export.json.\n\n")
        open(extras_path, "w").write(header + "\n\n---\n\n".join(sections) + "\n")
    elif os.path.exists(extras_path):
        os.remove(extras_path)

# 2. The export's other parts, copied as-is.
copied = []
for part in sorted(os.listdir(export_dir)):
    src = os.path.join(export_dir, part)
    if part == "conversations" or not os.path.isdir(src):
        continue
    shutil.copytree(src, os.path.join(archive_root, "_official-export", part), dirs_exist_ok=True)
    copied.append(part)

# 3. Coverage report.
by_status = collections.Counter()
file_rows, missing_files = collections.Counter(), []
th_total = th_live = 0
pasted_total = pasted_live = 0
for conv in official:
    live = conv["uuid"] in archived
    if live:
        by_status["fetched live from claude.ai"] += 1
    elif has_content(conv):
        by_status["no longer on claude.ai — rebuilt from the official export"] += 1
    else:
        by_status["no longer on claude.ai and empty in the official export"] += 1
    for m in conv["chat_messages"]:
        for b in m.get("content") or []:
            if b.get("type") == "thinking" and thinking_text(b).strip():
                th_total += 1
                th_live += live
        for a in m.get("attachments") or []:
            pasted_total += 1
            pasted_live += live
        pasted_names = {a.get("file_name") for a in m.get("attachments") or []}
        for f in m.get("files") or []:
            fu = f.get("file_uuid")
            if fu in saved_file_uuids:
                file_rows["original bytes saved"] += 1
            elif f.get("file_name") and f["file_name"] in pasted_names:
                file_rows["bytes gone, full text kept as pasted text"] += 1
            else:
                file_rows["not retrievable"] += 1
                missing_files.append(f"{f.get('file_name') or fu} — chat {conv.get('name') or conv['uuid'][:8]}{'' if live else ' (chat gone)'}")

report = ["# Coverage vs Claude's official export", "",
          f"Official export: {len(official)} chats. Archive: {len(archived)} chats fetched live.", "",
          "## Chats", ""] + [f"- {k}: **{v}**" for k, v in by_status.items()] + [
          "", "## Thinking blocks (non-empty)", "",
          f"- {th_live} of {th_total} are in live-fetched chats (full text in thinking.md / transcript.md);"
          f" the other {th_total - th_live} are in rebuilt chats", "",
          "## Pasted text", "", f"- {pasted_live} of {pasted_total} in live-fetched chats; the rest in rebuilt chats' pasted/", "",
          "## Files referenced by the official export", ""] + [f"- {k}: **{v}**" for k, v in file_rows.items()] + [
          "", "Live chats also keep files the official export never lists (sandbox outputs, tool images, earlier versions).", ""]
if missing_files:
    report += ["### Not retrievable", ""] + [f"- {x}" for x in missing_files] + [""]
report += ["## Tool detail the live API leaves out (kept from the official export)", "",
           "Each live chat folder has `conversation.official-export.json`; `official-export-extras.md` lists these per message:", ""]
report += [f"- {k}: **{v}**" for k, v in extras_total.most_common()] + [""]
report += ["## Also copied", "", f"- `_official-export/`: {', '.join(copied)}", ""]
open(os.path.join(archive_root, "_coverage.md"), "w").write("\n".join(report))
print("\n".join(report))
