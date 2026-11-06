export type View = { spent: number; stopped: boolean; week: number | null; resetsAt: string | null }

declare module 'claude-code' {
  interface PluginState {
    'budget-guard': { view: View | null }
  }
}
