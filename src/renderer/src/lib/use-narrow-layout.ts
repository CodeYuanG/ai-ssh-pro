import { useCallback, useEffect, useRef, useState } from 'react'
import type { LayoutPrefs } from './layout-prefs'

/**
 * UX-W01: narrow-window responsive downgrade for the three-pane shell.
 *
 * The persisted layout is the user's explicit choice and is NEVER modified.
 * This hook only derives the layout used for rendering on narrow viewports:
 *   - <= 1100px: auto-collapse the sidebar
 *   - <= 980px:  also auto-collapse the AI panel
 * Widening the window restores the persisted layout exactly.
 *
 * If the user manually toggles a pane while narrow, that toggle is remembered
 * as an override for the current narrow session so it is not re-collapsed.
 */
export const NARROW_SIDEBAR_BREAKPOINT = 1100
export const NARROW_AI_BREAKPOINT = 980

type Pane = 'showSidebar' | 'showAi'

export function useWindowWidth(initial = 1366): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? initial : window.innerWidth
  )
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

export function useNarrowLayout() {
  const width = useWindowWidth()
  const narrowSidebar = width <= NARROW_SIDEBAR_BREAKPOINT
  const narrowAi = width <= NARROW_AI_BREAKPOINT

  // Panes the user explicitly toggled while in narrow mode (survive re-renders).
  const [manual, setManual] = useState<Partial<Record<Pane, boolean>>>({})
  const prevNarrow = useRef({ sidebar: narrowSidebar, ai: narrowAi })

  // Clear manual overrides whenever the breakpoint state actually changes,
  // so widening/narrowing starts from the persisted layout again.
  useEffect(() => {
    const p = prevNarrow.current
    if (p.sidebar !== narrowSidebar || p.ai !== narrowAi) {
      setManual({})
      prevNarrow.current = { sidebar: narrowSidebar, ai: narrowAi }
    }
  }, [narrowSidebar, narrowAi])

  /**
   * Given the persisted layout, produce the layout to actually render.
   */
  const visibleLayout = useCallback(
    (prefs: LayoutPrefs): LayoutPrefs => {
      const next: LayoutPrefs = { ...prefs }
      if (narrowSidebar && manual.showSidebar === undefined) next.showSidebar = false
      if (narrowAi && manual.showAi === undefined) next.showAi = false
      if (manual.showSidebar !== undefined) next.showSidebar = manual.showSidebar
      if (manual.showAi !== undefined) next.showAi = manual.showAi
      return next
    },
    [narrowSidebar, narrowAi, manual]
  )

  /** Record an explicit user toggle for a pane while narrow. */
  const noteManualToggle = useCallback((pane: Pane, value: boolean) => {
    setManual((m) => ({ ...m, [pane]: value }))
  }, [])

  /**
   * Whether a pane is collapsed purely because of the viewport (not the user).
   * Used to show a hint toast the first time auto-collapse happens.
   */
  const isAutoCollapsed = useCallback(
    (pane: Pane, prefs: LayoutPrefs): boolean => {
      if (pane === 'showSidebar') return narrowSidebar && prefs.showSidebar && manual.showSidebar === undefined
      return narrowAi && prefs.showAi && manual.showAi === undefined
    },
    [narrowSidebar, narrowAi, manual]
  )

  return { width, narrowSidebar, narrowAi, visibleLayout, noteManualToggle, isAutoCollapsed }
}
