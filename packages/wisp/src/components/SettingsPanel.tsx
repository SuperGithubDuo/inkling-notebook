import { X } from 'lucide-react'
import { DEFAULT_SETTINGS, type WispSettings } from '../core/settings'

interface Props {
  settings: WispSettings
  onChange(p: Partial<WispSettings>): void
  onClose(): void
}

function Slider(props: { label: string; hint: string; value: number; min: number; max: number; step: number; format(v: number): string; onChange(v: number): void }) {
  return (
    <label className="field">
      <span className="field-head">
        <span>{props.label}</span>
        <span className="value">{props.format(props.value)}</span>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <span className="hint">{props.hint}</span>
    </label>
  )
}

function Toggle(props: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="toggle">
      <span>{props.label}</span>
      <input type="checkbox" role="switch" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="track" aria-hidden />
    </label>
  )
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const times = (v: number) => `${v.toFixed(2)}×`

export function SettingsPanel({ settings: s, onChange, onClose }: Props) {
  return (
    <div className="settings popover" role="dialog" aria-label="Settings">
      <div className="card-head">
        <h2>Settings</h2>
        <button className="icon" onClick={onClose} aria-label="Close settings">
          <X size={16} />
        </button>
      </div>

      <h3>Writing</h3>
      <Slider
        label="Writing sensitivity"
        hint="Higher: smaller hand movements cover the page."
        value={s.writingSensitivity}
        min={0.5}
        max={2}
        step={0.05}
        format={times}
        onChange={(v) => onChange({ writingSensitivity: v })}
      />
      <Slider
        label="Stroke smoothing"
        hint="Higher: steadier lines, slightly more lag. 0 turns it off."
        value={s.smoothing}
        min={0}
        max={1}
        step={0.05}
        format={pct}
        onChange={(v) => onChange({ smoothing: v })}
      />
      <Slider
        label="Pinch sensitivity"
        hint="Higher: a looser pinch puts the pen down."
        value={s.pinchSensitivity}
        min={0.5}
        max={2}
        step={0.05}
        format={times}
        onChange={(v) => onChange({ pinchSensitivity: v })}
      />
      <label className="field">
        <span className="field-head">
          <span>Pen tip</span>
        </span>
        <select value={s.penPoint} onChange={(e) => onChange({ penPoint: e.target.value === 'pinch' ? 'pinch' : 'index' })}>
          <option value="index">Index fingertip</option>
          <option value="pinch">Between thumb and index (experimental)</option>
        </select>
      </label>

      <h3>Camera</h3>
      <Toggle label="Mirror camera" checked={s.mirror} onChange={(v) => onChange({ mirror: v })} />
      <Toggle label="Show camera preview" checked={s.showPreview} onChange={(v) => onChange({ showPreview: v })} />
      <Toggle label="Show hand landmarks" checked={s.showLandmarks} onChange={(v) => onChange({ showLandmarks: v })} />
      <Toggle label="Developer diagnostics" checked={s.showDiagnostics} onChange={(v) => onChange({ showDiagnostics: v })} />

      <div className="row end">
        <button
          className="btn link sm"
          onClick={() =>
            onChange({
              writingSensitivity: DEFAULT_SETTINGS.writingSensitivity,
              smoothing: DEFAULT_SETTINGS.smoothing,
              pinchSensitivity: DEFAULT_SETTINGS.pinchSensitivity,
              penPoint: DEFAULT_SETTINGS.penPoint
            })
          }
        >
          Reset writing defaults
        </button>
      </div>
      <p className="privacy">Video is processed on this computer only. WISP never records, stores or uploads camera footage.</p>
    </div>
  )
}
