#!/usr/bin/env python3
"""Build archive-hints.json from Claude's official data export.

The official export (Settings → Privacy → Export data) lists every chat,
file and project in the account, but only names the files. The Full archive
page reads archive-hints.json from the extension folder and uses it as a map:
it fetches chats the list endpoints hide (incognito chats), tries every file
ID through /files/{id}/contents, and opens projects by ID.

Usage:
    python3 -I scripts/hints-from-official-export.py <extracted export dir> [out.json]

<extracted export dir> holds the unzipped parts, e.g. conversations/conversations.json
and projects/projects/*.json. The output defaults to archive-hints.json next to
manifest.json (git-ignored: it contains chat titles).
"""
import glob
import json
import os
import sys
from datetime import datetime, timezone

export_dir = sys.argv[1]
out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "archive-hints.json")

conversations_path = next(iter(glob.glob(os.path.join(export_dir, "**", "conversations.json"), recursive=True)), None)
if not conversations_path:
    sys.exit(f"no conversations.json under {export_dir}")
conversations = json.load(open(conversations_path))

hints = {
    "source": os.path.abspath(export_dir),
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "conversations": [],
    "files": [],
    "projects": [],
}
seen_files = set()
for conv in conversations:
    hints["conversations"].append({
        "uuid": conv["uuid"],
        "name": conv.get("name") or "",
        "created_at": conv.get("created_at"),
        "messages": len(conv.get("chat_messages") or []),
    })
    for message in conv.get("chat_messages") or []:
        for file in message.get("files") or []:
            file_uuid = file.get("file_uuid")
            if not file_uuid or file_uuid in seen_files:
                continue
            seen_files.add(file_uuid)
            hints["files"].append({
                "file_uuid": file_uuid,
                "file_name": file.get("file_name") or "",
                "conversation_uuid": conv["uuid"],
                "conversation_name": conv.get("name") or "",
                "message_uuid": message.get("uuid"),
                "sender": message.get("sender"),
            })

for path in sorted(glob.glob(os.path.join(export_dir, "**", "projects", "*.json"), recursive=True)):
    project = json.load(open(path))
    if project.get("uuid"):
        hints["projects"].append({"uuid": project["uuid"], "name": project.get("name") or ""})

with open(out_path, "w") as f:
    json.dump(hints, f, indent=1)
print(f"{out_path}: {len(hints['conversations'])} chats, {len(hints['files'])} files, {len(hints['projects'])} projects")
