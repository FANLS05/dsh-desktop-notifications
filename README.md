# dsh-desktop-notifications

**Windows toast notifications for [DeepSeek Harness](https://github.com/deepseek-ai) (dsh)** — get a native
notification in the bottom-right corner when DSH needs you (approval request, question) or finishes work
(run completed, error, sign-in required).

Every toast is **led by the conversation name**, so when several sessions are running you can tell at a
glance which one is calling you. Approval and question toasts fire **instantly, with no delay**, and the
text is **markdown-free** (`**`, `` ` ``, `~~` never leak into a notification).

```
小明的课表整理                                  <- line 1: conversation name (always)
需要你确认权限 · pwsh · 删除 Downloads 下的文件    <- line 2: what is happening
```

`dsh-plugin` · Windows-only host plugin · no dependencies · no build step · MIT

## Features

| | |
| --- | --- |
| 🔔 **The events that matter** | approval requests, user questions, run completion, agent errors, sign-in prompts |
| 🗂️ **Conversation name first** | line 1 is the session title folded from the session log, so notifications from different sessions never look alike |
| ⚡ **No delay for "needs you"** | approval/question toasts go out the moment the request arrives (a delay can be re-enabled per event) |
| 🧹 **Markdown-free text** | emphasis markers, code spans and link syntax are stripped; underscores and file names are preserved |
| 🪟 **Real Windows toasts** | posted under the DSH AppUserModelID (`com.deepseek.dsh`), so they show as *DeepSeek Harness* and land in the Action Center |
| 🧾 **Audit log** | one line per toast (`~/.dsh/dsh-desktop-notifications.log`) makes "why did nothing pop up?" answerable |
| 🪶 **No hard dependencies** | plain ESM + one PowerShell script, no compiler, no bundler, no native module (`@deepseek-ai/schemastery` is an *optional* peer used only to publish the settings form) |

## Triggers

| When | Event | Second line | Timing |
| --- | --- | --- | --- |
| DSH needs **permission** | `approval/request` | `需要你确认权限 · <tool> · <reason>` | instantly |
| DSH needs an **answer / choice** | `user-questions/request` | `正在等待你的选择 · <question>` | instantly |
| A run **completes** | `agent/status` → `idle` | `任务完成 · 用时 …，可以回来查看结果了。` | after 4 s of idle |
| A run **fails** | `agent/error` | `执行出错 · <message>` | instantly |
| **Sign-in** required / expired | `deepseek-account/*` | `需要登录 · …` | instantly |
| Child agent settled | `subagent/end` | `<name> 已结束。` | instantly (off by default) |
| Workflow run ended | `workflow/end` | `工作流运行已结束（…）。` | instantly (off by default) |

Two noise guards: an identical title+body is shown at most once per 1.5 s, and completion fires only when
the agent stays idle for 4 s (an auto-continuing `/goal` round cancels the pending toast).

> The second line is currently Chinese, matching the author's UI language. It is plain text in
> `lib/impl.js` — PRs that make the wording configurable are welcome.

## Install

```powershell
# from GitHub
dsh plugin --profile desktop add github:FANLS05/dsh-desktop-notifications

# or from a local checkout
dsh plugin --profile desktop add link:D:\path\to\dsh-desktop-notifications
```

Then enable the `desktop-notifications` row in the plugin manager (or leave it enabled — the bundle patch
inserts it enabled).

Requirements: Windows 10/11, DSH with the desktop profile, Node 20+ (the host supplies it).

Verify the channel without waiting for an event:

```powershell
node "$env:USERPROFILE\.dsh\plugins\dsh-desktop-notifications\scripts\notify-test.mjs"
node "$env:USERPROFILE\.dsh\plugins\dsh-desktop-notifications\scripts\notify-test.mjs" "**title**" "body `code`"
```

## Configuration

### From the GUI

The plugin exports a `Config` schema, which DSH serves as the row's settings document: open **Settings →
Plugins**, expand the *dsh-desktop-notifications* bundle and use the configure control on its
`desktop-notifications` row. Every switch below appears as an editable form, and saving re-applies it
immediately (no restart).

### From the profile patch

Add a `config:` block to the row in your profile patch
(`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`):

```yaml
- id: desktop-notifications
  config:
    notifySubagent: true     # also notify when a child agent settles
    notifyWorkflow: true     # also notify when a workflow run ends
    sound: false             # keep the toast, drop the sound
    stripMarkdown: false     # keep raw markdown in the text
    approvalDelayMs: 1500    # only ring if the request is still unanswered
    questionDelayMs: 1500
    notifyOnMount: true      # ring once on load (install check)
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `appId` | `com.deepseek.dsh` | AppUserModelID the toast is attributed to |
| `sound` | `true` | play the notification sound |
| `useElectron` | `true` | prefer Electron's in-process notification when the host is an Electron main process |
| `powershellPath` | `""` | explicit PowerShell path; empty auto-detects `powershell.exe` → `pwsh.exe` |
| `notifyApproval` / `notifyQuestion` / `notifyComplete` / `notifyError` / `notifyAccount` | `true` | per-event switches |
| `notifySubagent` / `notifyWorkflow` | `false` | opt-in extra events |
| `notifyOnMount` | `false` | self-check toast on load |
| `onlyRootSessions` | `true` | completion/child toasts only for root sessions |
| `useSessionTitle` | `true` | use the conversation name as the first line |
| `stripMarkdown` | `true` | strip markdown markers from title and body |
| `titleMaxChars` | `60` | first-line truncation |
| `titleCacheTtlMs` | `30000` | how long a folded title is cached |
| `approvalDelayMs` / `questionDelayMs` | `0` | `0` = instantly; raise to only ring unanswered requests |
| `idleGraceMs` | `4000` | idle time before "completed" counts |
| `dedupeWindowMs` | `1500` | identical-toast dedupe window |
| `bodyMaxChars` | `180` | second-line truncation |
| `logEnabled` / `logPath` / `logMaxBytes` | `true` / `""` / `262144` | audit log (default `~/.dsh/dsh-desktop-notifications.log`) |

The audit log records the final, cleaned text of every toast — the first place to look when debugging:

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-desktop-notifications.log" -Encoding UTF8 -Tail 20
```

## How it works

* **Two delivery lanes.** Lane 1 is Electron's own `Notification` (used when the host really is an
  Electron main process). Lane 2 is a PowerShell child process running `lib/toast.ps1`, which itself
  degrades through three channels: a WinRT toast under the DSH AppUserModelID, a WinRT toast under the
  built-in Windows PowerShell AppUserModelID, and finally a tray balloon.
* **Why PowerShell at all.** The DSH host process here is an Electron *utility* process, which has no
  `Notification` API, so the toast has to be posted out of process.
* **`detached: true` is a trap.** Spawning `powershell.exe` detached on Windows makes it exit after
  ~130 ms with code 0 without ever running the script; the same command line works when the child stays
  attached. That single flag is the difference between "notifications work" and "nothing ever appears".
* **Prepend, then delegate.** `approval/request` and `user-questions/request` are waterfalls claimed by
  the first listener that answers. The notification listener registers with `{ prepend: true }`, raises
  the toast, and always calls `next()` so the normal answerer still handles the request.
* **Conversation name.** The title is folded from the session log with `sessionQuery.readTitle()`; when an
  event carries no session (sign-in prompt, mount check), the plugin falls back to the most recently
  active conversation, then to the newest conversation in the log, and only then to `DSH`.

## Development

`lib/index.js` is a deliberately thin entry point: the DSH loader caches an imported plugin module **by
package name** and never re-imports it, so the entry re-imports the implementation with a cache-busting
query (`import('./impl.js?v=' + Date.now())`). That means **editing `lib/impl.js` only needs the row to be
disabled and re-enabled** — no host restart, no rename. Only changes to `lib/index.js` itself need a
restart.

No build step: the shipped JavaScript is the source.

## Limitations

* Windows only (other platforms load the plugin and do nothing).
* Windows Focus Assist / Do Not Disturb suppresses toasts — a system behaviour the plugin cannot bypass;
  the notifications still land in the Action Center.
* A freshly created session may not have a title yet (DSH generates it asynchronously); the toast then
  falls back to the previous level of the title chain.
* Markdown stripping is deliberately aggressive: a lone `*` (for example `*.txt`) is removed too. Set
  `stripMarkdown: false` if you need the raw text.

## Related plugins

The `dsh` ecosystem already has a healthy notification category — see
[awesome-dsh-plugin › Notifications & Integrations](https://github.com/billLiao/awesome-dsh-plugin/blob/main/categories/notifications-integrations.md).
Notably: [hotpot-labs/dsh-notifier-plugin](https://github.com/hotpot-labs/dsh-notifier-plugin) (cross-platform,
with a settings card), [lsq-dsh-plugins/dsh-windows-notifications](https://github.com/lsq-dsh-plugins/dsh-windows-notifications)
(Windows toasts + in-app cards), [masknull/dsh-webhook-notifier](https://github.com/masknull/dsh-webhook-notifier)
(HTTP webhooks), [zhangDSK-Xu/dsh-sound-alert](https://github.com/zhangDSK-Xu/dsh-sound-alert) (sound + card).

This plugin's angle: **zero dependencies, no build step, conversation name as the notification title,
instant "needs you" toasts, markdown-free text, and an audit log.**

## License

[MIT](LICENSE)
