/**
 * dsh-desktop-notifications - stable loader entry.
 *
 * Why this file exists: the DSH loader caches an imported plugin module by
 * package name and never re-imports it, so editing the plugin's code would
 * otherwise need renaming the package or restarting the host. This entry
 * re-imports the real implementation with a cache-busting query, so a plain
 * disable/enable of the row is enough to pick up new code.
 *
 * @module dsh-desktop-notifications
 */

const impl = await import(new URL(`./impl.js?v=${Date.now()}`, import.meta.url))

/** Plugin name shown by the loader. */
export const name = 'dsh-desktop-notifications'

/** Host body, forwarded from the freshly imported implementation. */
export const apply = impl.apply

/** Manual self-test helper, forwarded from the implementation. */
export const notifyTest = impl.notifyTest
