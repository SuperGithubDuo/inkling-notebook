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
        hint="Higher: steadier lines but slower to follow quick details. 0 turns it off."
        value={s.smoothing}
        min={0}
        max={1}
        step={0.05}
        format={pct}
        onChange={(v) => onChange({ smoothing: v })}
      />
      <Slider
        label="Jitter stabilizer"
        hint="Ignores tiny tremors while you write. Too high makes small letters look rounded."
        value={s.stabilizer}
        min={0}
        max={1}
        step={0.05}
        format={pct}
        onChange={(v) => onChange({ stabilizer: v })}
      />
      <Toggle label="Refine each stroke when the pen lifts" checked={s.refine} onChange={(v) => onChange({ refine: v })} />
      <p className="hint-text">Re-smooths the finished stroke without lag, so curves and stroke ends land where your finger went.</p>

      <h3>Pinch</h3>
      <Slider
        label="Pen-down sensitivity"
        hint="Higher: a looser pinch puts the pen down."
        value={s.pinchSensitivity}
        min={0.5}
        max={2}
        step={0.05}
        format={times}
        onChange={(v) => onChange({ pinchSensitivity: v })}
      />
      <Slider
        label="Pen-up sensitivity"
        hint="Higher: the pen lifts after a smaller or slower finger opening. Lower it if strokes break while writing."
        value={s.releaseSensitivity}
        min={0.5}
        max={2}
        step={0.05}
        format={times}
        onChange={(v) => onChange({ releaseSensitivity: v })}
      />
      <label className="field">
        <span className="field-head">
          <span>Pen tip</span>
        </span>
        <select value={s.penPoint} onChange={(e) => onChange({ penPoint: e.target.value === 'index' ? 'index' : 'midpoint' })}>
          <option value="midpoint">Between thumb and index (like holding a pen)</option>
          <option value="index">Index fingertip</option>
        </select>
      </label>
      <label className="field">
        <span className="field-head">
          <span>Pinch measurement</span>
        </span>
        <select
          value={s.pinchMetric}
          onChange={(e) => onChange({ pinchMetric: e.target.value === '2d' ? '2d' : e.target.value === '3d' ? '3d' : 'auto' })}
        >
          <option value="auto">Automatic (3D when the hand is turned)</option>
          <option value="3d">Always 3D hand shape</option>
          <option value="2d">Camera image only (v0.1.2)</option>
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
              stabilizer: DEFAULT_SETTINGS.stabilizer,
              refine: DEFAULT_SETTINGS.refine,
              pinchSensitivity: DEFAULT_SETTINGS.pinchSensitivity,
              releaseSensitivity: DEFAULT_SETTINGS.releaseSensitivity,
              penPoint: DEFAULT_SETTINGS.penPoint,
              pinchMetric: DEFAULT_SETTINGS.pinchMetric
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
