/**
 * Product facts shown in the app (About, feedback, privacy). One place, so a
 * rename or a new support address is a one-line change.
 */
export const PRODUCT_NAME = 'Inkling'
export const REPO_URL = 'https://github.com/SuperGithubDuo/inkling-notebook'
export const RELEASES_URL = `${REPO_URL}/releases`
/**
 * Where "Send feedback" goes: an https page (a new GitHub issue by default)
 * or a mailto: address. Set MAIN_VITE_INKLING_FEEDBACK_URL when building to
 * change it, e.g. to a support email for testers without a GitHub account.
 */
export const FEEDBACK_URL = 'https://github.com/SuperGithubDuo/inkling-notebook/issues/new'

/** A feedback link with the app version and system filled in. Never includes notebook content. */
export function feedbackLink(base: string, info: { version: string; platform: string; arch: string }): string {
  const system = `Inkling ${info.version} on ${platformName(info.platform)} (${info.arch})`
  const body = `What happened, or what would you like?\n\n\nSteps to reproduce (if it's a problem):\n1. \n\n---\n${system}`
  if (base.startsWith('mailto:')) {
    const sep = base.includes('?') ? '&' : '?'
    return `${base}${sep}subject=${encodeURIComponent(`Inkling feedback (${info.version})`)}&body=${encodeURIComponent(body)}`
  }
  const url = new URL(base)
  url.searchParams.set('title', 'Feedback: ')
  url.searchParams.set('body', body)
  return url.toString()
}

export function platformName(p: string): string {
  return p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p
}
