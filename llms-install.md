# Installing the Gemini Notebook (NotebookLM) MCP server

Instructions for an AI agent (Cline, Claude Code, Cursor…) setting this server up
for a user. Gemini Notebook is Google's new name for NotebookLM; the server
drives the same service.

## Requirements

- Node.js 22 or newer (`node --version`).
- A Google account with access to Gemini Notebook. A dedicated account is
  recommended for automation.
- A desktop session: the one-time login opens a visible Chrome window.

## 1. Add the server to the MCP configuration

No clone or build is needed; `npx` fetches the published package. The quickest
way is to let the server register itself with the clients it finds:

```bash
npx -y @roomi-fields/notebooklm-mcp setup --yes
```

Or add this entry to the client's MCP configuration by hand:

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "npx",
      "args": ["-y", "@roomi-fields/notebooklm-mcp@latest"]
    }
  }
}
```

No API key or environment variable is required for this local, stdio setup.

## 2. Log in to Google once — ask the user to run it in a terminal

```bash
npx -y -p @roomi-fields/notebooklm-mcp notebooklm-mcp-setup-auth
```

A Chrome window opens; the user signs in to Google and the browser closes
itself. The session is saved locally and reused by the server on every start.

Do not run the login as an MCP tool call: it waits for the user for up to ten
minutes, longer than most clients allow a tool call to last.

## 3. Check it works

Call the `get_health` tool. `authenticated: true` means the setup is complete.
Then `list_notebooks` returns the user's notebooks, and `ask_question` answers
from one of them with citations.

## Troubleshooting

- **`authenticated: false`** — run step 2 again; Google sessions expire.
- **Docker, NAS or headless server** — see the Docker section of the
  [README](https://github.com/roomi-fields/gemini-notebook-mcp#readme).
