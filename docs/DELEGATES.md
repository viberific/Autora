# Delegates: Claude and Gemini

Autora can hand a job to **Claude Code** or to **Gemini** (the `claude` and `gemini` command-line tools) and show what they do
as their own bubble in the conversation. They run on your own subscription, signed in as you: no API key, no per-token bill.
The code is `server/vendor.ts` (the contract) and `server/delegates/` (the two wrappers, copied to `dist/delegates/` by the build).

## What is in the image

The Docker image installs both CLIs (pinned in the `Dockerfile`: `CLAUDE_CODE_VERSION`, `GEMINI_CLI_VERSION`) and carries the
wrappers. The agent is offered `claude_cli` and `gemini_cli` only when the CLI is there, so a box without one never sees a tool
that would fail.

## Sign in once (the part only you can do)

A subscription login is interactive, so it is done by you, once, in the running container. On Umbrel, open its terminal or use
`docker exec`; the folder `/data/home` is where the sign-in is kept, and it survives updates:

```bash
# Claude Code: opens a link, you approve it in a browser and paste the code back.
docker exec -it <autora-container> sh -c 'HOME=/data/home claude'      # then type /login

# Gemini: choose "Login with Google" and follow the link.
docker exec -it <autora-container> sh -c 'HOME=/data/home gemini'
```

Check it worked by asking the agent to "ask Claude to read README.md". If it says the sign-in lapsed, repeat the step.

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
