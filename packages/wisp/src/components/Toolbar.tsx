import { useCallback, useRef, useState } from 'react'
import { useDismiss } from './useDismiss'
import { AlignLeft, Download, FileJson, Hand, HelpCircle, Image, MousePointer2, Redo2, RotateCcw, Settings2, Trash2, Undo2, Upload } from 'lucide-react'
import type { PenStyle } from '../strokes/types'

const COLORS = ['#1f2430', '#2f6be4', '#e5484d', '#1f9d63', '#6d63f0', '#e8870e']
const WIDTHS = [2, 4, 7, 11]

interface Props {
  mode: 'webcam' | 'mouse'
  onMode(m: 'webcam' | 'mouse'): void
  pen: PenStyle
  onPen(p: Partial<PenStyle>): void
  canUndo: boolean
  canRedo: boolean
  canClear: boolean
  onUndo(): void
  onRedo(): void
  onClear(): void
  onExportJson(): void
  onExportPng(): void
  onImport(f: File): void
  onSettings(): void
  onHelp(): void
  settingsOpen: boolean
  /** Writing Assist tools (v0.1.4); shown only in Writing Assist mode. */
  assist: boolean
  canTidy: boolean
  canRestore: boolean
  onTidy(): void
  onRestore(): void
}

export function Toolbar(p: Props) {
  const file = useRef<HTMLInputElement>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const clearRef = useRef<HTMLDivElement>(null)
  const exportRef = useRef<HTMLDivElement>(null)
  useDismiss(clearRef, confirmClear, useCallback(() => setConfirmClear(false), []))
  useDismiss(exportRef, exportOpen, useCallback(() => setExportOpen(false), []))

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path d="M4 15c3-7 6-9 8-6s3 6 8-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </span>
        <span className="brand-name">WISP</span>
        <span className="brand-sub">Inkling lab · v0.1.4</span>
      </div>

      <div className="segmented" role="tablist" aria-label="Input mode">
        <button role="tab" aria-selected={p.mode === 'webcam'} className={p.mode === 'webcam' ? 'on' : ''} onClick={() => p.onMode('webcam')}>
          <Hand size={15} /> Webcam
        </button>
        <button role="tab" aria-selected={p.mode === 'mouse'} className={p.mode === 'mouse' ? 'on' : ''} onClick={() => p.onMode('mouse')}>
          <MousePointer2 size={15} /> Mouse
        </button>
      </div>

      <div className="tool-group" aria-label="Pen">
        <div className="swatches" role="radiogroup" aria-label="Pen colour">
          {COLORS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={p.pen.color === c}
              aria-label={`Colour ${c}`}
              className={`swatch ${p.pen.color === c ? 'on' : ''}`}
              style={{ ['--swatch' as string]: c }}
              onClick={() => p.onPen({ color: c })}
            />
          ))}
          <label className="swatch custom" title="Custom colour">
            <input type="color" value={p.pen.color} onChange={(e) => p.onPen({ color: e.target.value })} aria-label="Custom colour" />
          </label>
        </div>
        <div className="divider" />
        <div className="widths" role="radiogroup" aria-label="Pen thickness">
          {WIDTHS.map((w) => (
            <button key={w} role="radio" aria-checked={p.pen.width === w} aria-label={`Thickness ${w}`} title={`${w} px`} className={`width ${p.pen.width === w ? 'on' : ''}`} onClick={() => p.onPen({ width: w })}>
              <span style={{ width: Math.max(3, w * 1.3), height: Math.max(3, w * 1.3), background: p.pen.color }} />
            </button>
          ))}
        </div>
      </div>

      <div className="tool-group">
        <button className="icon" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
          <Undo2 size={17} />
        </button>
        <button className="icon" onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <Redo2 size={17} />
        </button>
        {p.assist && (
          <>
            <button className="icon" onClick={p.onTidy} disabled={!p.canTidy} title="Tidy lines: straighten slightly tilted lines (whole lines move, letters never change)" aria-label="Tidy lines">
              <AlignLeft size={17} />
            </button>
            <button className="icon" onClick={p.onRestore} disabled={!p.canRestore} title="Restore original: put tidied lines back exactly as written" aria-label="Restore original">
              <RotateCcw size={17} />
            </button>
          </>
        )}
        <div className="popover-anchor" ref={clearRef}>
          <button className="icon" onClick={() => setConfirmClear((v) => !v)} disabled={!p.canClear} title="Clear page" aria-label="Clear page">
            <Trash2 size={17} />
          </button>
          {confirmClear && p.canClear && (
            <div className="popover small" role="dialog">
              <p>Clear the whole page?</p>
              <p className="muted">You can undo this.</p>
              <div className="row">
                <button className="btn ghost" onClick={() => setConfirmClear(false)}>Cancel</button>
                <button
                  className="btn danger"
                  onClick={() => {
                    p.onClear()
                    setConfirmClear(false)
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="spacer" />

      <div className="tool-group">
        <button className="btn ghost" onClick={() => file.current?.click()} title="Import WISP JSON">
          <Upload size={15} /> Import
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) p.onImport(f)
            e.target.value = ''
          }}
        />
        <div className="popover-anchor" ref={exportRef}>
          <button className="btn ghost" onClick={() => setExportOpen((v) => !v)} aria-expanded={exportOpen}>
            <Download size={15} /> Export
          </button>
          {exportOpen && (
            <div className="popover menu" role="menu">
              <button role="menuitem" onClick={() => (setExportOpen(false), p.onExportJson())}>
                <FileJson size={15} /> Strokes (JSON)
                <span className="muted">vector data</span>
              </button>
              <button role="menuitem" onClick={() => (setExportOpen(false), p.onExportPng())}>
                <Image size={15} /> Image (PNG)
              </button>
            </div>
          )}
        </div>
        <button className={`icon ${p.settingsOpen ? 'active' : ''}`} onClick={p.onSettings} title="Settings" aria-label="Settings">
          <Settings2 size={17} />
        </button>
        <button className="icon" onClick={p.onHelp} title="How to write with WISP" aria-label="Help">
          <HelpCircle size={17} />
        </button>
      </div>
    </header>
  )
}
