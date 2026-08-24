export type WorkbenchDestination =
  | { view: 'apps'; settings?: never }
  | { settings: WorkbenchSettingsSection; view?: never }
  | Record<string, never>

export type WorkbenchSettingsSection =
  | 'runtime' | 'model' | 'coding' | 'appearance' | 'skills' | 'capabilities'
  | 'apps' | 'automations' | 'updates' | 'support' | 'about' | 'privacy' | 'legal'

const SETTINGS_SECTIONS = new Set<WorkbenchSettingsSection>([
  'runtime', 'model', 'coding', 'appearance', 'skills', 'capabilities',
  'apps', 'automations', 'updates', 'support', 'about', 'privacy', 'legal',
])

export function parseWorkbenchDestination(search: string): WorkbenchDestination {
  const params = new URLSearchParams(search)
  if (params.get('view') === 'apps') return { view: 'apps' }
  const settings = params.get('settings')
  if (settings && SETTINGS_SECTIONS.has(settings as WorkbenchSettingsSection)) return { settings: settings as WorkbenchSettingsSection }
  return {}
}

export function applyWorkbenchDestination(url: string, destination: WorkbenchDestination): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
  const next = new URL(url, 'http://aiden.local')
  next.searchParams.delete('view')
  next.searchParams.delete('settings')
  if ('view' in destination && destination.view) next.searchParams.set('view', destination.view)
  if ('settings' in destination && destination.settings) next.searchParams.set('settings', destination.settings)
  return absolute ? next.toString() : `${next.pathname}${next.search}${next.hash}`
}

const RUNTIME_SELECTION_KEYS = ['session', 'job', 'attempt', 'run'] as const

/** Reconcile durable run identity without discarding an explicit product
 * destination. User-initiated chat selection passes preserveDestination=false
 * so Apps/Settings close intentionally; background restore and reload pass true. */
export function applyWorkbenchSelection(
  url: string,
  selectionSearch: string,
  preserveDestination: boolean,
): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
  const next = new URL(url, 'http://aiden.local')
  const destination = preserveDestination ? parseWorkbenchDestination(next.search) : {}
  for (const key of RUNTIME_SELECTION_KEYS) next.searchParams.delete(key)
  const selection = new URLSearchParams(selectionSearch.startsWith('?') ? selectionSearch.slice(1) : selectionSearch)
  for (const key of RUNTIME_SELECTION_KEYS) {
    const value = selection.get(key)
    if (value !== null) next.searchParams.set(key, value)
  }
  next.searchParams.delete('view')
  next.searchParams.delete('settings')
  if ('view' in destination && destination.view) next.searchParams.set('view', destination.view)
  if ('settings' in destination && destination.settings) next.searchParams.set('settings', destination.settings)
  return absolute ? next.toString() : `${next.pathname}${next.search}${next.hash}`
}
