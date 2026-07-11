import type { MemoryRecord } from '@cat-house/shared';

export function MemoryPanel({ memories, loading }: { memories: readonly MemoryRecord[]; loading: boolean }) {
  if (loading) return <p className="panel-state">Loading memories...</p>;
  if (memories.length === 0) return <p className="panel-state">No durable memories yet.</p>;
  return (
    <ol className="memory-list">
      {memories.map((memory) => (
        <li className="memory-row" key={memory.id}>
          <p>{memory.content}</p>
          <div className="memory-meta">
            <span>{Math.round(memory.importance * 100)}% importance</span>
            <span>{memory.sourceMessageId ? 'Conversation source' : 'Agent inference'}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
