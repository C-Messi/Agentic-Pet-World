import { CloudOff, LoaderCircle, PawPrint, TriangleAlert } from 'lucide-react';
import type { ConnectionStatus } from '../game/events';

const statusLabels: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  ready: 'Ready',
  thinking: 'Thinking',
  acting: 'Acting',
  offline: 'Offline',
  cancelled: 'Canceled',
  'provider-error': 'Provider error',
};

export function StatusBar({ status, message }: { status: ConnectionStatus; message?: string }) {
  const Icon = status === 'offline'
    ? CloudOff
    : status === 'provider-error'
      ? TriangleAlert
      : status === 'connecting' || status === 'thinking' || status === 'acting'
        ? LoaderCircle
        : PawPrint;
  return (
    <div className={`status-strip status-${status}`} role="status" aria-live="polite">
      <Icon className={status === 'connecting' || status === 'thinking' || status === 'acting' ? 'status-spinner' : ''} aria-hidden="true" />
      <span>{statusLabels[status]}</span>
      {message ? <span className="status-message">{message}</span> : null}
    </div>
  );
}
