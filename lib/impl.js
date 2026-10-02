/**
 * dsh-notifications - host half.
 *
 * Turns the DSH events that need a human into Windows toast notifications in
 * the bottom-right corner of the desktop. EVERY notification leads with the
 * conversation title, so two sessions never look alike:
 *
 *   <会话名称>                             <- bold first line, always
 *   需要你确认权限 · bash · <原因>          <- second line: what is happening
 *
 * Wired events:
 *   approval/request                     -> "需要你确认权限"   (fired at once)
 *   user-questions/request               -> "正在等待你的选择" (fired at once)
 *   agent/status (idle, after running)   -> "任务完成"
 *   agent/error                          -> "执行出错"
 *   deepseek-account/model-sign-in-required / session-expired -> "需要登录"
 *   subagent/end, workflow/end           -> optional, off by default
 *
 * Delivery has two lanes, tried in order:
 *   1. Electron's own `Notification` (when the host is an Electron main process).
 *   2. `lib/toast.ps1` in a PowerShell child process.
 *
 * @module dsh-notifications
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin name shown by the loader. */
export const name = 'dsh-notifications'

/** The PowerShell lane that ships beside this module. */
const SCRIPT_PATH = fileURLToPath(new URL('./toast.ps1', import.meta.url))

/** `require` seam: Electron is a CommonJS built-in of the host process. */
const requireFromHere = createRequire(import.meta.url)

/**
 * Load the optional `@deepseek-ai/schemastery` peer.
 *
 * A `link:`-installed plugin cannot resolve the profile's dependencies by
 * walking up from its own directory, so besides the plain import this also
 * probes the profile directories a DSH install keeps beside the plugin. An
 * `undefined` result only means "no settings form is offered"; the plugin
 * itself keeps working from the config object alone.
 *
 * @returns the schemastery namespace, or undefined when it cannot be loaded.
 */
async function loadSchemastery() {
  try {
    const loaded = await import('@deepseek-ai/schemastery')
    const z = loaded?.default ?? loaded
    if (z !== undefined && typeof z.object === 'function') return z
  } catch {
    /* not resolvable from here: fall through to the profile-anchored probes */
  }
  const envHome = process.env.DSH_HOME
  const home = typeof envHome === 'string' && envHome.trim() !== '' ? envHome.trim() : join(homedir(), '.dsh')
  const bases = [
    process.cwd(),
    join(home, 'profiles', 'desktop'),
    join(home, 'profiles', 'web'),
    join(home, 'profiles', 'default'),
  ]
  for (const base of bases) {
    try {
      const request = createRequire(join(base, 'package.json'))
      const loaded = request('@deepseek-ai/schemastery')
      const z = loaded?.default ?? loaded
      if (z !== undefined && typeof z.object === 'function') return z
    } catch {
      /* try the next base */
    }
  }
  return undefined
}

/** Default configuration; every field can be overridden from the profile patch. */
const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** AppUserModelID the toast is attributed to (the DSH desktop app's id). */
  appId: 'com.deepseek.dsh',
  /** Play the notification sound. */
  sound: true,
  /** Try Electron's in-process notification when the host runs under Electron. */
  useElectron: true,
  /** PowerShell executable for the other lane; empty means auto-detect. */
  powershellPath: '',
  /** Notify while an approval request waits for a human. */
  notifyApproval: true,
  /** Notify while a user question waits for a choice. */
  notifyQuestion: true,
  /** Notify when a session finishes its turn and goes idle. */
  notifyComplete: true,
  /** Notify on agent errors. */
  notifyError: true,
  /** Notify when the account needs a sign-in. */
  notifyAccount: true,
  /** Notify when a delegated child agent settles (off: usually noisy). */
  notifySubagent: false,
  /** Notify when a workflow run settles (off: usually noisy). */
  notifyWorkflow: false,
  /** Fire a toast when the plugin mounts, which doubles as an install check. */
  notifyOnMount: false,
  /** Completion/child notifications only for root sessions, not subagents. */
  onlyRootSessions: true,
  /** Title = the conversation title; false uses the fixed fallback title. */
  useSessionTitle: true,
  /** Strip markdown markers out of the title/body before showing the toast. */
  stripMarkdown: true,
  /** A resolved conversation title is truncated to this many characters. */
  titleMaxChars: 60,
  /** How long a folded conversation title stays cached. */
  titleCacheTtlMs: 30000,
  /** Delay before announcing an approval. 0 = immediately (the default). */
  approvalDelayMs: 0,
  /** Delay before announcing a question. 0 = immediately (the default). */
  questionDelayMs: 0,
  /** Idle must hold this long before it counts as "done" (goal rounds re-enter fast). */
  idleGraceMs: 4000,
  /** Drop a repeated identical toast inside this window. */
  dedupeWindowMs: 1500,
  /** Body text is truncated to this many characters. */
  bodyMaxChars: 180,
  /** Append one line per notification to an audit log (useful when diagnosing). */
  logEnabled: true,
  /** Audit log path; empty means `<DSH home>/dsh-desktop-notifications.log`. */
  logPath: '',
  /** Rotate the audit log once it grows past this size. */
  logMaxBytes: 262144,
}

/**
 * The row's Config schema.
 *
 * DSH serves this as the row's settings document, so the Plugins page grows an
 * editable form for every field below; saving it re-enters `apply()` through
 * `loader/volatile-update`, with no restart. A plugin that also wants bespoke
 * UI can register the `plugins.row.config` slot instead — this schema is the
 * dependency-free path to the same "change the switches in the GUI" outcome.
 *
 * @param z - the schemastery namespace.
 * @returns the Config schema for this plugin.
 */
function buildConfigSchema(z) {
  const toggle = (description, value) => z.boolean().default(value).description(description)
  const count = (description, value) => z.number().default(value).description(description)
  const text = (description, value) => z.string().default(value).description(description)
  return z
    .object({
      enabled: toggle('总开关', true),
      appId: text('通知归属的 AppUserModelID（默认 DSH 桌面端自己的）', 'com.deepseek.dsh'),
      sound: toggle('是否播放提示音', true),
      useElectron: toggle('宿主是 Electron 主进程时优先用 Electron 原生通知', true),
      powershellPath: text('指定 PowerShell 路径，空则自动探测 powershell.exe → pwsh.exe', ''),
      notifyApproval: toggle('需要你同意权限时通知', true),
      notifyQuestion: toggle('需要你选择/作答时通知', true),
      notifyComplete: toggle('任务完成时通知', true),
      notifyError: toggle('执行出错时通知', true),
      notifyAccount: toggle('需要登录或登录过期时通知', true),
      notifySubagent: toggle('子代理结束时也通知', false),
      notifyWorkflow: toggle('工作流结束时也通知', false),
      notifyOnMount: toggle('插件每次加载时发一条自检通知', false),
      onlyRootSessions: toggle('完成类通知只针对根会话', true),
      useSessionTitle: toggle('用会话名当通知第一行', true),
      stripMarkdown: toggle('去掉标题/正文里的 markdown 符号', true),
      titleMaxChars: count('第一行截断长度', 60),
      titleCacheTtlMs: count('会话名缓存时长（毫秒）', 30000),
      approvalDelayMs: count('授权通知延时（毫秒，0 = 立即）', 0),
      questionDelayMs: count('提问通知延时（毫秒，0 = 立即）', 0),
      idleGraceMs: count('空闲多久才算“完成”（毫秒）', 4000),
      dedupeWindowMs: count('相同通知去重窗口（毫秒）', 1500),
      bodyMaxChars: count('第二行截断长度', 180),
      logEnabled: toggle('写审计日志', true),
      logPath: text('审计日志路径，空则 ~/.dsh/dsh-desktop-notifications.log', ''),
      logMaxBytes: count('日志超过该大小就轮转（字节）', 262144),
    })
    .description('dsh-desktop-notifications 的桌面通知配置')
}

/** The schemastery namespace, or undefined when the peer cannot be loaded. */
const schemastery = await loadSchemastery()

/** Settings document DSH serves for the `desktop-notifications` row. */
export const Config = schemastery === undefined ? undefined : buildConfigSchema(schemastery)

/**
 * Merge the row config over the defaults, dropping values of the wrong type so a
 * malformed patch entry degrades to a working default instead of throwing.
 * @param config - the raw config object the loader passed to apply().
 * @returns a fully populated, type-checked configuration.
 */
function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const resolved = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') resolved[key] = value
      continue
    }
    if (typeof fallback === 'number') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) resolved[key] = value
      continue
    }
    if (typeof value === 'string') resolved[key] = value
  }
  return resolved
}

/** Resolve the audit log path; an empty `logPath` means `<DSH home>/dsh-notifications.log`. */
function logPathOf(config) {
  if (typeof config.logPath === 'string' && config.logPath.trim() !== '') return config.logPath
  const envHome = process.env.DSH_HOME
  const home = typeof envHome === 'string' && envHome.trim() !== '' ? envHome.trim() : join(homedir(), '.dsh')
  return join(home, 'dsh-desktop-notifications.log')
}

/**
 * Append one audit line so `why did no toast appear?` has an answer outside the
 * host process. Never throws: a broken log must not break a turn.
 */
function appendLog(config, line) {
  if (!config.logEnabled) return
  try {
    const path = logPathOf(config)
    mkdirSync(dirname(path), { recursive: true })
    try {
      if (statSync(path).size > config.logMaxBytes) renameSync(path, `${path}.1`)
    } catch {
      /* the log does not exist yet */
    }
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* logging must never break a turn */
  }
}

/**
 * Strip inline markdown so a toast never shows `**`, backticks or `~~`.
 *
 * The text is authored by the model (tool reasons, question text, session
 * titles), so emphasis markers and code spans would otherwise leak into the
 * notification verbatim. Underscores are deliberately left alone: they are far
 * more common inside file names and identifiers than as emphasis.
 */
function stripMarkdown(value) {
  return String(value ?? '')
    // code spans / fences: keep the code, drop the backticks
    .replace(/`{1,3}([^`]*?)`{1,3}/g, '$1')
    // images and links: keep the label
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // bold / italic / strikethrough markers wrapped around real text
    .replace(/(\*\*\*|\*\*|~~|\*)(?=\S)([\s\S]*?\S)\1/g, '$2')
    // heading and quote marks at the start of a line
    .replace(/(^|\n)\s*#{1,6}\s+/g, '$1')
    .replace(/(^|\n)\s*>\s?/g, '$1')
    // anything left over that only ever carried markdown meaning
    .replace(/[*~`]/g, '')
}

/** Collapse whitespace and cut the text to `max` characters with an ellipsis. */
function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Human-readable elapsed time such as `3 秒` / `2 分 05 秒`. */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${String(minutes % 60).padStart(2, '0')} 分`
}

/** Best-effort human message out of an unknown thrown value. */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const message = error.message
    if (typeof message === 'string') return message
    const reason = error.reason
    if (typeof reason === 'string') return reason
    const code = error.code
    if (typeof code === 'string') return code
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error ?? '')
}

/** Pick the localised approval reason when the harness supplied one. */
function approvalReason(req) {
  const display = req?.displayReason
  if (display !== null && typeof display === 'object') {
    for (const key of ['zh-CN', 'zh', 'zh-Hans', 'en']) {
      const value = display[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  const reason = req?.reason
  return typeof reason === 'string' ? reason : ''
}

/** First id-looking value among the candidates, so payloads can vary safely. */
function pickSessionId(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
    if (candidate !== null && typeof candidate === 'object') {
      const id = candidate.id
      if (typeof id === 'string' && id !== '') return id
    }
  }
  return ''
}

/**
 * Lane 1: Electron's in-process notification. Only a real Electron main process
 * has this; the DSH host here does not, so it usually falls through to lane 2.
 * @returns true when Electron accepted the notification.
 */
async function deliverViaElectron(config, title, body, trace) {
  if (!config.useElectron) return false
  if (typeof process.versions.electron !== 'string') return false
  let Notification
  try {
    const loaded = requireFromHere('electron')
    Notification = loaded?.Notification ?? loaded?.default?.Notification
  } catch (error) {
    trace(`electron lane unavailable: ${errorMessage(error)}`)
    return false
  }
  if (typeof Notification !== 'function') {
    trace('electron lane unavailable: no Notification export')
    return false
  }
  try {
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
      trace('electron lane unavailable: isSupported() === false')
      return false
    }
    new Notification({ title, body, silent: !config.sound, urgency: 'critical' }).show()
    trace('electron lane: Notification.show() called')
    return true
  } catch (error) {
    trace(`electron lane failed: ${errorMessage(error)}`)
    return false
  }
}

/**
 * Lane 2: PowerShell running `lib/toast.ps1`. Every lifecycle event is traced,
 * because a helper process that dies early is otherwise invisible.
 *
 * NOTE: this must NOT pass `detached: true`. On Windows a detached spawn makes
 * powershell.exe exit immediately (measured: 130 ms, exit code 0) without ever
 * executing the script; the same command line runs correctly when the child
 * stays attached.
 *
 * @returns a promise that settles when the helper exits (or every candidate failed).
 */
function deliverViaPowerShell(config, title, body, trace) {
  const executables = config.powershellPath !== '' ? [config.powershellPath] : ['powershell.exe', 'pwsh.exe']
  const env = {
    ...process.env,
    DSH_NOTIFY_TITLE: title,
    DSH_NOTIFY_BODY: body,
    DSH_NOTIFY_APPID: config.appId,
    DSH_NOTIFY_SOUND: config.sound ? 'true' : 'false',
  }
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    SCRIPT_PATH,
  ]
  const attempt = (index) =>
    new Promise((resolve) => {
      if (index >= executables.length) {
        trace('powershell lane: no usable executable')
        resolve()
        return
      }
      const executable = executables[index]
      let child
      try {
        child = spawn(executable, args, { env, windowsHide: true, stdio: 'ignore' })
      } catch (error) {
        trace(`powershell lane: spawn threw for ${executable}: ${errorMessage(error)}`)
        resolve(attempt(index + 1))
        return
      }
      let settled = false
      child.on('error', (error) => {
        trace(`powershell lane: ${executable} error: ${errorMessage(error)}`)
        if (settled) return
        settled = true
        resolve(attempt(index + 1))
      })
      child.on('spawn', () => trace(`powershell lane: ${executable} spawned (pid ${child.pid})`))
      child.on('exit', (code, signal) => {
        trace(`powershell lane: ${executable} exited code=${code} signal=${signal}`)
        if (settled) return
        settled = true
        resolve()
      })
    })
  return attempt(0)
}

/** Raise one toast through the best available lane. */
async function deliver(config, title, body, trace) {
  if (process.platform !== 'win32') return
  const shown = await deliverViaElectron(config, title, body, trace)
  if (!shown) await deliverViaPowerShell(config, title, body, trace)
}

/**
 * Send one toast outside the plugin lifecycle. Exposed for the bundled
 * `scripts/notify-test.mjs` check and for `node -e` smoke tests.
 * @param title - toast title (the first line).
 * @param body - toast body (the second line).
 * @param overrides - partial config, resolved over the defaults.
 * @returns a promise that settles once the toast has been handed to Windows.
 */
export function notifyTest(title = 'DSH 通知测试', body = '右下角 Windows 通知通道工作正常。', overrides = {}) {
  const config = resolveConfig(overrides)
  const clean = config.stripMarkdown ? stripMarkdown : (value) => value
  const heading = truncate(clean(title), config.titleMaxChars)
  const text = truncate(clean(body), config.bodyMaxChars)
  appendLog(config, `manual test :: ${heading} :: ${text}`)
  return deliver(config, heading, text, (line) => appendLog(config, `manual test :: ${line}`)).catch(() => {})
}

/**
 * Host body: watch the "a human is needed" events and raise a Windows toast.
 * @param ctx - host root context.
 * @param config - the row's resolved configuration.
 */
export function apply(ctx, config) {
  let disposed = false
  let lastTitle = ''
  let lastBody = ''
  let lastAt = 0
  /** sessionId -> epoch ms when its current turn started running. */
  const turnStarted = new Map()
  /** sessionId -> pending idle timer. */
  const idleTimers = new Map()
  /** sessionId -> the agent has been observed running at least once. */
  const everRan = new Set()
  /** sessionId -> { title, at } folded from the session log. */
  const titleCache = new Map()
  /** The conversation the user touched (or ran) most recently. */
  let lastActiveSessionId = ''

  const log = (message) => {
    try {
      ctx.logger?.debug?.(`[dsh-notifications] ${message}`)
    } catch {
      /* logging must never break a turn */
    }
  }

  /** Remember a conversation id so session-less events still lead with a name. */
  const rememberSession = (...candidates) => {
    const id = pickSessionId(...candidates)
    if (id !== '') lastActiveSessionId = id
    return id
  }

  /** Raise one toast, honouring the master switch and the duplicate window. */
  const fire = (title, body) => {
    if (disposed) return false
    const cfg = resolveConfig(config)
    if (!cfg.enabled) return false
    const clean = cfg.stripMarkdown ? stripMarkdown : (value) => value
    const text = truncate(clean(body), cfg.bodyMaxChars)
    const heading = truncate(clean(title), cfg.titleMaxChars)
    const now = Date.now()
    if (heading === lastTitle && text === lastBody && now - lastAt < cfg.dedupeWindowMs) return false
    lastTitle = heading
    lastBody = text
    lastAt = now
    appendLog(cfg, `toast :: ${heading} :: ${text}`)
    // Fire and forget: a notification must never block an agent turn.
    void deliver(cfg, heading, text, (line) => appendLog(cfg, `  ${line}`)).catch(() => {})
    return true
  }

  /**
   * Fold one session's latest title out of its log. Cheap, cached for a short
   * TTL, and every failure degrades to "no title" rather than to a lost toast.
   * @returns the title, or '' when the log has none / cannot be read.
   */
  const sessionTitle = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return ''
    const cfg = resolveConfig(config)
    if (!cfg.useSessionTitle) return ''
    const cached = titleCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < cfg.titleCacheTtlMs) return cached.title
    let title = ''
    try {
      const query = ctx.get('sessionQuery')
      if (query !== undefined && typeof query.readTitle === 'function') {
        const snapshot = await query.readTitle(sessionId)
        if (typeof snapshot?.title === 'string') title = snapshot.title.trim()
      }
    } catch {
      title = ''
    }
    titleCache.set(sessionId, { title, at: Date.now() })
    return title
  }

  /**
   * The newest conversation in the corpus, used only when neither the event nor
   * the activity feed named one (a sign-in prompt, the mount check, ...).
   */
  const newestSessionId = async () => {
    try {
      const query = ctx.get('sessionQuery')
      if (query !== undefined && typeof query.listSessions === 'function') {
        const records = await query.listSessions()
        if (Array.isArray(records) && records.length > 0) {
          const id = records[0]?.header?.id
          if (typeof id === 'string' && id !== '') return id
        }
      }
    } catch {
      /* fall through to the app-name heading */
    }
    return ''
  }

  /**
   * Fire a toast whose FIRST LINE is always a conversation title: the event's
   * own session when it has one, otherwise the last conversation in use, and
   * finally the newest conversation in the corpus. Only when no title can be
   * folded at all does it fall back to the app name.
   */
  const fireFor = (sessionId, body) => {
    void (async () => {
      let title = await sessionTitle(sessionId)
      if (title === '' && lastActiveSessionId !== '' && lastActiveSessionId !== sessionId) {
        title = await sessionTitle(lastActiveSessionId)
      }
      if (title === '') {
        const newest = await newestSessionId()
        if (newest !== '' && newest !== sessionId) title = await sessionTitle(newest)
      }
      fire(title === '' ? 'DSH' : title, body)
    })().catch(() => {
      /* a notification must never surface an error into the host */
    })
  }

  /** Whether this session is a root session (not a delegated child). */
  const isRootSession = (agent) => {
    const id = agent?.id
    if (typeof id !== 'string' || id === '') return true
    let agents
    try {
      agents = ctx.get('agents')
    } catch {
      return true
    }
    if (agents === undefined || typeof agents.roots !== 'function') return true
    try {
      return agents.roots().some((candidate) => candidate?.id === id)
    } catch {
      return true
    }
  }

  const clearIdleTimer = (id) => {
    const timer = idleTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      idleTimers.delete(id)
    }
  }

  /**
   * Subscribe to a "a human must answer this" waterfall event.
   *
   * These are claimed by whichever listener answers first, so this listener is
   * PREPENDED: it must be reached before the composed answerer (the web client)
   * claims the request, otherwise no notification is ever raised. It always
   * delegates with `next()` and never lets its own failure break the request.
   *
   * The notification itself is synchronous: the user asked for no delay, so the
   * toast goes out the moment the request arrives. `approvalDelayMs` /
   * `questionDelayMs` can reintroduce a delay (and then only ring when the
   * request is still unanswered).
   */
  const onWaiting = (event, delayOf, topic, describe) => {
    const listener = (payload, next) => {
      try {
        const cfg = resolveConfig(config)
        const enabled =
          (event === 'approval/request' && cfg.notifyApproval) ||
          (event === 'user-questions/request' && cfg.notifyQuestion)
        if (cfg.enabled && enabled) {
          const sessionId = rememberSession(payload?.agent, payload?.request?.agent)
          const body = `${topic} · ${describe(payload)}`
          const delay = delayOf(cfg)
          if (delay <= 0) {
            fireFor(sessionId, body)
          } else {
            const timer = setTimeout(() => fireFor(sessionId, body), delay)
            if (typeof timer.unref === 'function') timer.unref()
          }
        }
      } catch {
        /* never break the request */
      }
      return next()
    }
    try {
      ctx.on(event, listener, { prepend: true })
    } catch {
      try {
        ctx.on(event, listener, true)
      } catch {
        ctx.on(event, listener)
      }
    }
  }

  onWaiting(
    'approval/request',
    (cfg) => cfg.approvalDelayMs,
    '需要你确认权限',
    (req) => {
      const tool = typeof req?.toolName === 'string' && req.toolName !== '' ? req.toolName : '未知工具'
      const reason = approvalReason(req)
      return reason === '' ? tool : `${tool} · ${reason}`
    },
  )

  onWaiting(
    'user-questions/request',
    (cfg) => cfg.questionDelayMs,
    '正在等待你的选择',
    (request) => {
      const questions = Array.isArray(request?.questions) ? request.questions : []
      const first = questions[0]
      const head = typeof first?.header === 'string' && first.header !== '' ? `${first.header}：` : ''
      const text = typeof first?.question === 'string' ? first.question : '有一条待回答的问题'
      const more = questions.length > 1 ? `（共 ${questions.length} 项）` : ''
      return `${head}${text}${more}`
    },
  )

  // Remember which conversation the user is working in, so events that carry no
  // session of their own still lead with a conversation name.
  ctx.on('api-session/activity', (sessionId) => {
    rememberSession(sessionId)
  })

  ctx.on('agent/status', (payload) => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled || !cfg.notifyComplete) return
    const agent = payload?.agent
    const id = agent?.id
    if (typeof id !== 'string' || id === '') return
    const status = payload?.status

    if (status === 'running') {
      clearIdleTimer(id)
      everRan.add(id)
      turnStarted.set(id, Date.now())
      rememberSession(id)
      return
    }
    if (status !== 'idle') return
    rememberSession(id)
    if (!everRan.has(id)) return
    if (cfg.onlyRootSessions && !isRootSession(agent)) return

    clearIdleTimer(id)
    const timer = setTimeout(() => {
      idleTimers.delete(id)
      const started = turnStarted.get(id)
      turnStarted.delete(id)
      const elapsed = typeof started === 'number' ? ` · 用时 ${formatDuration(Date.now() - started)}` : ''
      fireFor(id, `任务完成${elapsed}，可以回来查看结果了。`)
    }, cfg.idleGraceMs)
    if (typeof timer.unref === 'function') timer.unref()
    idleTimers.set(id, timer)
  })

  ctx.on('agent/error', (payload) => {
    const cfg = resolveConfig(config)
    if (!cfg.notifyError) return
    const id = rememberSession(payload?.agent)
    const message = truncate(errorMessage(payload?.error), 120)
    fireFor(id, `执行出错 · ${message === '' ? '有一轮执行失败，请查看会话详情。' : message}`)
  })

  ctx.on('deepseek-account/model-sign-in-required', () => {
    const cfg = resolveConfig(config)
    if (!cfg.notifyAccount) return
    fireFor(lastActiveSessionId, '需要登录 · 模型请求需要登录 DeepSeek 账号。')
  })

  ctx.on('deepseek-account/session-expired', () => {
    const cfg = resolveConfig(config)
    if (!cfg.notifyAccount) return
    fireFor(lastActiveSessionId, '登录已过期 · 请重新登录 DeepSeek 账号。')
  })

  ctx.on('subagent/end', (info) => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled || !cfg.notifySubagent) return
    const id = rememberSession(info?.parentSessionId, info?.sessionId, info?.childSessionId, info?.agent)
    const label = typeof info?.name === 'string' && info.name !== '' ? info.name : '子任务'
    fireFor(id, `子任务 ${label} 已结束。`)
  })

  ctx.on('workflow/end', (info, result) => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled || !cfg.notifyWorkflow) return
    const id = rememberSession(info?.sessionId, info?.parentSessionId, info?.agent)
    const reason = typeof result?.stopReason === 'string' ? result.stopReason : ''
    fireFor(id, reason === '' ? '工作流运行已结束。' : `工作流运行已结束（${reason}）。`)
  })

  ctx.on('loader/volatile-update', () => {
    // A settings save mutates the config object in place; nothing else to do.
    log('configuration re-applied')
  })

  ctx.effect(() => {
    if (process.platform !== 'win32') {
      log('non-Windows platform: notifications stay disabled')
      return () => {}
    }
    log(`mounted (script: ${SCRIPT_PATH})`)
    appendLog(
      resolveConfig(config),
      `mounted :: pid=${process.pid} :: electron=${process.versions.electron ?? '-'} :: script=${SCRIPT_PATH}`,
    )
    if (resolveConfig(config).notifyOnMount) {
      fireFor(lastActiveSessionId, '桌面通知已启用 · 需要你操作或任务完成时，会在右下角弹出通知。')
    }
    return () => {
      disposed = true
      for (const timer of idleTimers.values()) clearTimeout(timer)
      idleTimers.clear()
      turnStarted.clear()
      everRan.clear()
      titleCache.clear()
    }
  }, 'dsh-notifications: runtime')
}
