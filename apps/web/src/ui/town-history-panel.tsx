import type { TownEvent, TownResidentState } from '@cat-house/shared';

export function TownHistoryPanel({ events, residents: _residents, loading }: { events: readonly TownEvent[]; residents: readonly TownResidentState[]; loading: boolean }) {
  if (loading) return <p className="panel-state">正在加载小镇动态...</p>;
  if (events.length === 0) return <p className="panel-state">还没有小镇动态。</p>;
  return <ol className="town-list">{[...events].reverse().map((event) => <li key={event.id}><strong>{eventLabel(event)}</strong><time>{new Date(event.timestamp).toLocaleString()}</time></li>)}</ol>;
}

export function eventLabel(event: TownEvent): string {
  if (event.type === 'resident.spoke') return event.payload.text;
  if (event.type === 'fortune.revealed') return `抽到了${event.payload.rank}签`;
  if (event.type === 'fortune.interpreted') return event.payload.interpretation;
  const labels: Partial<Record<TownEvent['type'], string>> = { 'residents.played': '和朋友一起玩耍', 'build.completed': '完成了一次小镇改造', 'stall.opened': '个性展摊开张了', 'stall.visited': '拜访了个性展摊', 'stall.closed': '个性展摊收摊了', 'outing.started': '出发去小镇', 'outing.returned': '从小镇回家' };
  return labels[event.type] ?? '小镇有了新动态';
}
