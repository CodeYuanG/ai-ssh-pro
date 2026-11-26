import type { WebContents } from 'electron'
import type { AiDebugStreamPayload } from '../shared/ipc'

let target: WebContents | null = null

export function setDebugWindowWebContents(wc: WebContents | null): void {
  target = wc
}

/** True when a debug window is open. Callers use it to skip building debug payloads. */
export function hasDebugWindow(): boolean {
  const t = target
  if (!t || t.isDestroyed()) {
    target = null
    return false
  }
  return true
}

/** 将调试条目推送到独立调试窗口（若已打开） */
export function forwardDebugPayloadToWindow(payload: AiDebugStreamPayload): void {
  if (!hasDebugWindow()) return
  target!.send('ai-debug:push', payload)
}
