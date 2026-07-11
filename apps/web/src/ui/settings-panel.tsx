import type { ConnectionStatus } from '../game/events';

export function SettingsPanel({ apiUrl, status, muted, onMutedChange }: {
  apiUrl: string;
  status: ConnectionStatus;
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
}) {
  return (
    <div className="settings-list">
      <div className="settings-row">
        <span>Provider</span>
        <strong>{status === 'provider-error' ? 'Degraded' : 'Configured on server'}</strong>
      </div>
      <div className="settings-row settings-url">
        <span>API URL</span>
        <code>{apiUrl || 'Same origin'}</code>
      </div>
      <label className="settings-row settings-toggle">
        <span>Sound</span>
        <input type="checkbox" checked={!muted} onChange={(event) => onMutedChange(!event.target.checked)} />
      </label>
      <p className="settings-note">Provider credentials and model settings are read-only in the browser.</p>
    </div>
  );
}
