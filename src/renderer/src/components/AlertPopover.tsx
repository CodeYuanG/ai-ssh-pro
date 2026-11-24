import { useEffect, useRef } from 'react'
import type { FiredAlert } from '@shared/alert-rules'
import { ageBucket } from '@shared/alert-workbench'
import { useI18n, type MessageKey } from '../lib/i18n'
import { alertTone } from './AlertLine'
import Icon from './Icon'

type Props = {
  open: boolean
  alerts: FiredAlert[]
  now: number
  onClose: () => void
  /** Open the full workbench, optionally focused on one alert. */
  onOpenWorkbench: (alertId?: string) => void
  onOpenRules: () => void
}

const AGE_KEY: Record<'just' | 'min' | 'hour' | 'day', MessageKey> = {
  just: 'l2.justNow',
  min: 'l2.agoMin',
  hour: 'l2.agoHour',
  day: 'l2.agoDay'
}

const RULE_KEY: Record<string, MessageKey> = {
  cpu: 'l2.metricCpu',
  mem: 'l2.metricMem',
  disk: 'l2.metricDisk',
  offline: 'l2.offline'
}

/**
 * Bell popover: shows current alerts inline without creating a tab.
 * Opening the full workbench is an explicit action (a row or the footer button).
 */
export default function AlertPopover({ open, alerts, now, onClose, onOpenWorkbench, onOpenRules }: Props) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const n = e.target
      if (n instanceof Node && rootRef.current?.contains(n)) return
      // Bell click toggles this popover itself; don't double-handle it here.
      if (n instanceof Element && n.closest('[data-testid="alert-bell"]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])

  if (!open) return null

  const active = alerts.filter((a) => a.status === 'active')
  return (
    <div className="alert-popover" ref={rootRef} role="dialog" aria-label={t('l2.title')} data-testid="alert-popover">
      <div className="alert-popover-head">
        <Icon name="bell" size={14} />
        <span>{t('l2.title')}</span>
        <span className="alert-popover-count">{t('l2.activeN', { n: active.length })}</span>
        <button type="button" className="alert-popover-x" aria-label={t('common.close')} onClick={onClose}>×</button>
      </div>
      <div className="alert-popover-list">
        {active.length === 0 ? (
          <div className="alert-popover-empty">
            <Icon name="check" size={22} />
            <p>{t('l2.empty')}</p>
          </div>
        ) : (
          active.map((a) => {
            const age = ageBucket(a.at, now)
            const tone = alertTone(a.ruleId)
            const rule = RULE_KEY[a.ruleId] ? t(RULE_KEY[a.ruleId]!) : a.ruleId
            // Offline alerts carry no percentage: the rule name already says it.
            const meta = a.ruleId === 'offline'
              ? `${rule} · ${t(AGE_KEY[age.key], { n: age.n })}`
              : `${rule} · ${Math.round(a.value)}% · ${t(AGE_KEY[age.key], { n: age.n })}`
            return (
              <button
                type="button"
                key={a.id}
                className={`alert-popover-row tone-${tone}`}
                data-testid="alert-popover-row"
                onClick={() => onOpenWorkbench(a.id)}
              >
                <span className="alert-popover-dot" aria-hidden />
                <span className="alert-popover-row-main">
                  <span className="alert-popover-host">{a.hostTitle}</span>
                  <span className="alert-popover-meta">{meta}</span>
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
            )
          })
        )}
      </div>
      <div className="alert-popover-foot">
        <button type="button" className="alert-popover-link" onClick={() => onOpenWorkbench()}>{t('l2.title')} →</button>
        <button type="button" className="alert-popover-link" onClick={onOpenRules}>{t('o2.rulesTitle')}</button>
      </div>
    </div>
  )
}
