import type { Plugin } from 'vite'
export function buildPhonePadPage(root?: string): Promise<{ html: string; inputs: string[] }>
export function phonepadPagePlugin(root?: string): Plugin
