# Claude Dashboard pane (mod)

A pane inside the Claude app with two tabs:

- **Home:** active chats, items needing your action (questions, approvals, errors), and recent chats.
- **Analytics:** turns per day, tokens, reported cost, top models, projects and tools, for 7, 14, 30 or 90 days.

It reads the transcripts Claude keeps in `~/.claude/projects`. It is read-only and sends nothing anywhere.

## Requirements
- Node.js 18 or newer on PATH.

## Install
At the prompt of a terminal Claude session:

```
/plugin install claude-dashboard-pane --marketplace Prudhvi-Raj1806/claude-dashboard-pane
```

From a shell:

```
claude plugin install claude-dashboard-pane --marketplace Prudhvi-Raj1806/claude-dashboard-pane
```

## Use
Type `/dashboard` to open the pane.

## Notes
- The pane refreshes every 15 seconds and runs `dashboard/server.js --json` to read the data.
- "Needs your action" is inferred: a tool call with no result in a chat that has gone quiet. Items older than 3 days are ignored.
- Costs are the figures Claude Code records, not billing numbers.
