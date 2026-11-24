import type { DashScope } from '@shared/dashboard-scope'
import { useI18n } from '../lib/i18n'

/**
 * Group tabs for the ops home host grid.
 *
 * Replaces the old mode-select + folder-select pair: one row of tabs where the
 * first tab means "all hosts" and every following tab is a saved folder. A
 * click filters directly, no dropdown step in between.
 */
export default function ScopePicker({
  scope,
  folders,
  onChange
}: {
  scope: DashScope
  folders: { id: string; name: string }[]
  hosts?: { id: string; title: string }[]
  onChange: (next: DashScope) => void
}) {
  const { t } = useI18n()
  const activeFolder = scope.mode === 'group' ? scope.folderId ?? '' : ''

  return (
    <div className="oh-group-tabs" role="tablist" aria-label={t('l7.scope')} data-testid="scope-picker">
      <button
        type="button"
        role="tab"
        data-testid="scope-mode"
        aria-selected={scope.mode === 'all'}
        className={`oh-group-tab${scope.mode === 'all' ? ' is-on' : ''}`}
        onClick={() => onChange({ mode: 'all' })}
      >
        {t('l7.scopeAll')}
      </button>
      {folders.map((f) => {
        const on = scope.mode === 'group' && activeFolder === f.id
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={`oh-group-tab${on ? ' is-on' : ''}`}
            data-testid="scope-group"
            title={f.name}
            onClick={() => onChange({ mode: 'group', folderId: f.id })}
          >
            {f.name}
          </button>
        )
      })}
    </div>
  )
}
