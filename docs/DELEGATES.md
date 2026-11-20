# Delegates: Claude and Gemini

Autora can hand a job to **Claude Code** or to **Gemini** (the `claude` and `gemini` command-line tools) and show what they do
as their own bubble in the conversation. They run on your own subscription, signed in as you: no API key, no per-token bill.
The code is `server/vendor.ts` (the contract) and `server/delegates/` (the two wrappers, copied to `dist/delegates/` by the build).

## What is in the image

The Docker image installs both CLIs (pinned in the `Dockerfile`: `CLAUDE_CODE_VERSION`, `GEMINI_CLI_VERSION`) and carries the
wrappers. The agent is offered `claude_cli` and `gemini_cli` only when the CLI is there, so a box without one never sees a tool
that would fail.

## Sign in once (the part only you can do)

Open Settings, Providers and models, and the **Claude (subscription)** or **Gemini (subscription)** row, and press **Sign in**.
Autora runs the CLI's own sign-in (`server/cli-signin.ts`): open the sign-in page it links to, approve it in your browser, and
paste the code the page shows. The sign-in is kept in `/data/home` (`AUTORA_DELEGATE_HOME`), which survives updates, and it is the
same sign-in the chat providers and the `claude_cli` / `gemini_cli` delegates use.

- Claude runs `claude auth login --claudeai`, which reads the code as it is.
- Gemini runs the `gemini` CLI in a terminal of its own (python3's pty: it asks for its code only in one), after setting its auth
  type to "Sign in with Google" in `/data/home/.gemini/settings.json`. Where a box has Antigravity's `agy` (on PATH or in
  `/data/bin`, `AUTORA_BIN_DIR`), Gemini runs on that instead, with its own sign-in.

The terminal way still works: `docker exec -it <autora-container> sh -c 'HOME=/data/home claude'` (then `/login`), or the same with
`gemini`. Check it worked by chatting on the provider, or by asking the agent to "ask Claude to read README.md".

An API key in the environment (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`) is not passed to the CLIs: with one, they
would answer on the key, billed per token, instead of on the subscription. `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`)
is passed, since it is a subscription sign-in.

## Running outside Docker

Install the CLIs (`npm install -g @anthropic-ai/claude-code @google/gemini-cli`), sign in as you normally do, and start Autora
from the repository: the wrappers are found in `server/delegates/` and use your own home folder. Set `AUTORA_DELEGATE_HOME` to keep
their sign-in somewhere else.

## Your own wrapper

A wrapper you write still wins. Put it at `/data/bin/claude-call.sh` (or `gemini-call.sh`), or point `AUTORA_CLAUDE_CLI` /
`AUTORA_GEMINI_CLI` at it; it follows the stream contract at the top of `server/vendor.ts`.

## What each can do

- Without `write`, Claude may read (Read, Glob, Grep) and Gemini is not approved to run anything; with `write`, edits are accepted.
- Both stream: text as it comes, the tools they call as status lines, then the answer and the tokens used.
- Failures are sorted for you: a lapsed sign-in, a quota that has been reached, a CLI that is missing, or a timeout.
