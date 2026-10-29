/**
 * The application menu. Replaces Electron's default one, which in a shipped
 * app would offer Reload (discarding unsaved edits) and Developer Tools.
 *
 * Keyboard shortcuts on the page (undo, copy, select all…) are handled by the
 * renderer: Chromium sends key presses to the page first and only passes
 * unhandled ones to the menu, so the standard Edit roles below don't take
 * them away from the canvas, and still work in text fields.
 */
import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { AppCommand } from '@shared/ipc'

export function buildMenu(opts: { send: (command: AppCommand) => void; dev: boolean; checkForUpdates?: () => void }): Menu {
  const mac = process.platform === 'darwin'
  const cmd = (label: string, command: AppCommand, accelerator?: string): MenuItemConstructorOptions => ({ label, accelerator, click: () => opts.send(command) })
  const updates: MenuItemConstructorOptions[] = opts.checkForUpdates ? [{ label: 'Check for Updates…', click: opts.checkForUpdates }] : []

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              cmd('About Inkling', 'about'),
              ...updates,
              { type: 'separator' },
              cmd('Settings…', 'settings', 'Cmd+,'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        cmd('Back Up Library…', 'backup'),
        cmd('Restore from Backup…', 'restore'),
        { type: 'separator' },
        ...(mac ? [] : [cmd('Settings…', 'settings', 'Ctrl+,'), { type: 'separator' } as const]),
        mac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        ...(opts.dev ? [{ type: 'separator' } as const, { role: 'reload' } as const, { role: 'toggleDevTools' } as const] : [])
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        cmd('Getting Started', 'welcome'),
        cmd('Send Feedback or Report a Problem…', 'feedback'),
        cmd('Privacy', 'privacy'),
        ...(mac ? [] : [{ type: 'separator' } as const, ...updates, cmd('About Inkling', 'about')])
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}
