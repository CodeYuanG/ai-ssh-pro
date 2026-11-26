import { useCallback, useEffect, useRef, useState } from 'react'
import {
  TOAST_VISIBLE_CAP,
  admitToast,
  inferToastTheme,
  type ToastTheme
} from '@shared/toast-queue'
import Icon from '../components/Icon'
import { tg } from './i18n'

/** Non-blocking notifications (ux-spec §3: toast instead of alert).
 *  Mounted inside the bottom status bar so notices never overlap the chat composer. */
export type ToastAction = { label: string; run: () => void }
type Toast = {
  id: number
  message: string
  actions: ToastAction[]
  kind: 'info' | 'error'
  ms: number
  theme: ToastTheme
}

const listeners = new Set<(t: Toast) => void>()
const clearListeners = new Set<() => void>()
let seq = 0

export function clearToasts(): void {
  for (const fn of clearListeners) fn()
}

export function showToast(
  message: string,
  opts?: {
    action?: ToastAction
    actions?: ToastAction[]
    kind?: 'info' | 'error'
    ms?: number
    theme?: ToastTheme
  }
): void {
  const kind = opts?.kind ?? 'info'
  const theme = opts?.theme ?? inferToastTheme(message, kind)
  const actions = opts?.actions ?? (opts?.action ? [opts.action] : [])
  const t: Toast = {
    id: ++seq,
    message,
    actions,
    kind,
    theme,
    ms: opts?.ms ?? (actions.length ? 8000 : 4000)
  }
  for (const fn of listeners) fn(t)
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([])
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setItems((prev) => prev.filter((x) => x.id !== id))
  }, [])

  useEffect(() => {
    const fn = (t: Toast) => {
      setItems((prev) => admitToast(prev, t, TOAST_VISIBLE_CAP) as Toast[])
      const timer = window.setTimeout(() => {
        timers.current.delete(t.id)
        dismiss(t.id)
      }, t.ms)
      timers.current.set(t.id, timer)
    }
    const clear = () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer)
      timers.current.clear()
      setItems([])
    }
    listeners.add(fn)
    clearListeners.add(clear)
    return () => {
      listeners.delete(fn)
      clearListeners.delete(clear)
      for (const timer of timers.current.values()) window.clearTimeout(timer)
      timers.current.clear()
    }
  }, [dismiss])

  if (!items.length) return null
  return (
    <div
      className="toast-stack"
      role="status"
      aria-live="polite"
      data-testid="toast-stack"
      data-toast-cap={TOAST_VISIBLE_CAP}
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.kind}`}
          data-testid="toast"
          data-toast-theme={t.theme}
          title={t.message}
        >
          <span className="statusbar-toast-glyph" aria-hidden>
            <Icon name={t.kind === 'error' ? 'triangle-alert' : 'bell'} size={12} strokeWidth={1.5} />
          </span>
          <span className="statusbar-toast-label">{t.message}</span>
          {t.actions.length ? (
            <span className="toast-actions">
              {t.actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  data-testid="toast-action"
                  onClick={() => {
                    dismiss(t.id)
                    action.run()
                  }}
                >
                  {action.label}
                </button>
              ))}
            </span>
          ) : null}
          <button
            type="button"
            className="statusbar-toast-close"
            data-testid="toast-dismiss"
            aria-label={tg('common.close')}
            title={tg('common.close')}
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
