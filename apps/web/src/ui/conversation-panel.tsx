import type { MessageRecord } from '@cat-house/shared';

export function ConversationPanel({ messages, loading }: { messages: readonly MessageRecord[]; loading: boolean }) {
  if (loading) return <p className="panel-state">Loading conversation...</p>;
  if (messages.length === 0) return <p className="panel-state">No messages yet.</p>;
  return (
    <ol className="conversation-list">
      {messages.map((message) => (
        <li className={`message-row message-${message.role}`} key={message.id}>
          <span className="message-role">{message.role === 'player' ? 'You' : message.role === 'agent' ? 'Cat' : 'System'}</span>
          <p>{message.content}</p>
        </li>
      ))}
    </ol>
  );
}
