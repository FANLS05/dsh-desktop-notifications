/**
 * Manual check for the notification channel, independent of the DSH host:
 *
 *   node scripts/notify-test.mjs
 *   node scripts/notify-test.mjs "自定义标题" "自定义内容"
 *
 * A toast must appear in the bottom-right corner of the desktop. The process
 * waits for the delivery lane to finish, so running this from a shell that
 * tears down its children still reports the real result.
 */

import { notifyTest } from '../lib/index.js'

const title = process.argv[2] ?? 'DSH 通知测试'
const body = process.argv[3] ?? '右下角 Windows 通知通道工作正常。'

if (process.platform !== 'win32') {
  console.error('this plugin only sends notifications on Windows')
  process.exit(2)
}

await notifyTest(title, body)
console.log(`toast requested: ${title} / ${body}`)
