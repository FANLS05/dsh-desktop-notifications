# dsh-desktop-notifications

**给 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）用的 Windows 桌面通知插件** ——
DSH 需要你操作（申请权限、提问）或干完活（完成、出错、需要登录）时，
在 **Windows 桌面右下角**弹出原生 Toast，不用一直盯着浏览器标签页。

每条通知的**第一行都是会话名称**，多个对话同时跑时一眼分辨是谁在叫你；
授权 / 提问类通知**零延时立即弹**，并且正文会自动**去掉 markdown 符号**
（不会在通知里看到 `**`、`` ` ``、`~~`）。

```
小明的课表整理                                  <- 第一行：会话名称（所有通知都是）
需要你确认权限 · pwsh · 删除 Downloads 下的文件    <- 第二行：具体事项
```

`dsh-plugin` · 仅 Windows 宿主插件 · 零依赖 · 无需构建 · MIT

## 特性

| | |
| --- | --- |
| 🔔 **只发重要的事** | 申请权限、提问、任务完成、执行出错、需要登录 |
| 🗂️ **第一行永远是会话名** | 从会话日志折叠标题，不同对话的通知不会再混淆 |
| ⚡ **"需要你"零延时** | 授权/提问一出现就弹（可分别配置延时，只在仍未被回答时才弹） |
| 🧹 **自动去 markdown** | 去掉 `**`、`` ` ``、`~~`、`[文字](链接)`；下划线与文件名保留 |
| 🪟 **真正的系统通知** | 归属 DSH 自己的 AppUserModelID（`com.deepseek.dsh`），显示为 *DeepSeek Harness*，并进入通知中心 |
| 🧾 **审计日志** | 每条通知记一行（`~/.dsh/dsh-desktop-notifications.log`），排查"为什么没弹"有据可查 |
| 🪶 **零依赖** | 纯 ESM + 一个 PowerShell 脚本，无编译器、无打包器、无原生模块 |

## 触发时机

| 时机 | 事件 | 第二行 | 何时弹 |
| --- | --- | --- | --- |
| 需要你**同意权限** | `approval/request` | `需要你确认权限 · <工具> · <原因>` | 立即 |
| 需要你**选择 / 作答** | `user-questions/request` | `正在等待你的选择 · <问题>` | 立即 |
| **任务完成** | `agent/status` → `idle` | `任务完成 · 用时 …，可以回来查看结果了。` | 空闲满 4 秒 |
| 执行**出错** | `agent/error` | `执行出错 · <错误摘要>` | 立即 |
| 需要**登录 / 登录过期** | `deepseek-account/*` | `需要登录 · …` | 立即 |
| 子代理结束 | `subagent/end` | `<子任务名> 已结束。` | 立即（默认关闭） |
| 工作流结束 | `workflow/end` | `工作流运行已结束（…）。` | 立即（默认关闭） |

两个防打扰设计：相同标题+正文 1.5 秒内只弹一次；"完成"要求 agent 空闲持续 4 秒才弹，
这期间又进入下一轮（例如 `/goal` 自动续跑）就取消这次通知。

## 安装

```powershell
# 从 GitHub 安装
dsh plugin --profile desktop add github:FANLS05/dsh-desktop-notifications

# 或者从本地目录安装
dsh plugin --profile desktop add link:D:\path\to\dsh-desktop-notifications
```

然后在插件管理里确认 `desktop-notifications` 这一行是启用的即可（bundle patch 默认就是启用状态）。

环境要求：Windows 10/11 + DSH 桌面版（Node 20+ 由宿主提供）。

不想等真实事件时，可以直接自检：

```powershell
node "$env:USERPROFILE\.dsh\plugins\dsh-desktop-notifications\scripts\notify-test.mjs"
node "$env:USERPROFILE\.dsh\plugins\dsh-desktop-notifications\scripts\notify-test.mjs" "**标题**" "正文 `code`"
```

## 配置

在 profile 的 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里给这一行加 config：

```yaml
- id: desktop-notifications
  config:
    notifySubagent: true     # 子代理结束也通知
    notifyWorkflow: true     # 工作流结束也通知
    sound: false             # 静音（通知仍在）
    stripMarkdown: false     # 保留原始 markdown
    approvalDelayMs: 1500    # 只在仍未被回答时才弹
    questionDelayMs: 1500
    notifyOnMount: true      # 每次加载弹一条，便于确认通道正常
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `appId` | `com.deepseek.dsh` | 通知归属的 AppUserModelID |
| `sound` | `true` | 是否播放提示音 |
| `useElectron` | `true` | 宿主是 Electron 主进程时优先用其原生通知 |
| `powershellPath` | `""` | 指定 PowerShell，空则自动找 `powershell.exe` → `pwsh.exe` |
| `notifyApproval` / `notifyQuestion` / `notifyComplete` / `notifyError` / `notifyAccount` | `true` | 各类事件开关 |
| `notifySubagent` / `notifyWorkflow` | `false` | 可选事件（默认关） |
| `notifyOnMount` | `false` | 加载时自检通知 |
| `onlyRootSessions` | `true` | 完成类通知只针对根会话 |
| `useSessionTitle` | `true` | 用会话名当第一行 |
| `stripMarkdown` | `true` | 去掉标题/正文里的 markdown |
| `titleMaxChars` | `60` | 第一行截断长度 |
| `titleCacheTtlMs` | `30000` | 会话名缓存时长 |
| `approvalDelayMs` / `questionDelayMs` | `0` | `0` = 立即；调大则只在未被回答时弹 |
| `idleGraceMs` | `4000` | 空闲多久才算"完成" |
| `dedupeWindowMs` | `1500` | 相同通知去重窗口 |
| `bodyMaxChars` | `180` | 第二行截断长度 |
| `logEnabled` / `logPath` / `logMaxBytes` | `true` / `""` / `262144` | 审计日志（默认 `~/.dsh/dsh-desktop-notifications.log`） |

审计日志记的是**清洗之后**的最终文本：

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-desktop-notifications.log" -Encoding UTF8 -Tail 20
```

## 实现要点

* **两条投递通道**：优先用 Electron 的 `Notification`（宿主真是 Electron 主进程时）；
  否则起一个 PowerShell 子进程跑 `lib/toast.ps1`，脚本内部再三级降级：
  DSH 的 AppUserModelID → Windows PowerShell 内置 AppUserModelID → 通知区域气泡。
* **为什么要起子进程**：这里的 DSH 宿主其实是 Electron 的 *utility* 进程，没有 `Notification` API。
* **`detached: true` 是坑**：在 Windows 上 detached 启动 `powershell.exe` 会让它 ~130ms 就以
  退出码 0 结束、脚本根本没执行；同样的命令行只要不 detached 就正常。这一个参数决定了"能不能收到通知"。
* **prepend 再委托**：`approval/request` / `user-questions/request` 是瀑布事件，谁先应答谁"认领"。
  通知监听器用 `{ prepend: true }` 抢在最前面发通知，然后照常 `next()`，不影响原有应答方。
* **会话名的取值链**：`sessionQuery.readTitle()` 折叠日志里的标题；事件不带会话时（登录提醒、
  自检）依次退到"最近活动的对话" → "日志里最新的对话" → `DSH`。

## 开发

`lib/index.js` 是刻意做薄的入口：DSH 的 loader **按包名缓存已加载的模块**且不会重新 import，
所以入口用 `import('./impl.js?v=' + Date.now())` 绕开缓存 ——
**改 `lib/impl.js` 只需要在插件管理里把该行禁用再启用一次**，不用重启宿主、也不用改包名；
只有改 `lib/index.js` 本身才需要重启。

没有构建步骤：仓库里的 JavaScript 就是最终产物。

## 已知限制

* 仅在 Windows 生效；其它平台加载后不做任何事。
* Windows 的「专注助手 / 勿扰模式」会压制 Toast —— 系统行为，插件绕不过去（通知仍会进通知中心）。
* 刚创建的会话可能还没有标题（DSH 异步生成），此时第一行会退到上一级。
* 去 markdown 是"宁可多去"：正文里单独出现的 `*`（例如 `*.txt`）也会被去掉，
  需要原文就设 `stripMarkdown: false`。

## 同类插件

DSH 生态里的通知类插件已经不少，见
[awesome-dsh-plugin › Notifications & Integrations](https://github.com/billLiao/awesome-dsh-plugin/blob/main/categories/notifications-integrations.md)
（收录了 35 个）。比较有代表性的：
[hotpot-labs/dsh-notifier-plugin](https://github.com/hotpot-labs/dsh-notifier-plugin)（跨平台，带设置卡片）、
[lsq-dsh-plugins/dsh-windows-notifications](https://github.com/lsq-dsh-plugins/dsh-windows-notifications)（Windows 通知 + 应用内卡片）、
[masknull/dsh-webhook-notifier](https://github.com/masknull/dsh-webhook-notifier)（HTTP Webhook）、
[zhangDSK-Xu/dsh-sound-alert](https://github.com/zhangDSK-Xu/dsh-sound-alert)（提示音 + 提醒卡片）。

本插件的差异点：**零依赖、无需构建、第一行是会话名、授权/提问零延时、自动去 markdown、带审计日志。**

## 许可

[MIT](LICENSE)
