import type { PublicShowcaseItem } from '@cat-house/shared';
import { useState } from 'react';

export function ShowcasePanel({ items, sessionId, loading, onSave, onDelete }: { items: readonly PublicShowcaseItem[]; sessionId: string; loading: boolean; onSave: (item: PublicShowcaseItem) => void | Promise<void>; onDelete: (id: string) => void | Promise<void> }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  if (loading) return <p className="panel-state">正在加载公开展摊...</p>;
  const add = () => {
    if (!title.trim() || !content.trim() || !confirmed) return;
    void onSave({ id: `showcase-${Date.now()}`, sessionId, kind: 'text', title: title.trim(), content: content.trim(), presetIconId: 'star', isPublic: true });
    setTitle(''); setContent(''); setConfirmed(false);
  };
  return <div className="showcase-editor">
    <p className="showcase-note">这里只展示你主动填写并确认公开的个性资料，不会读取聊天或记忆。</p>
    <label>标题<input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>公开内容<textarea aria-label="公开内容" value={content} maxLength={280} onChange={(event) => setContent(event.target.value)} /></label>
    <label className="public-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />确认公开这条资料</label>
    <button type="button" disabled={!title.trim() || !content.trim() || !confirmed} onClick={add}>添加公开展示</button>
    {items.length === 0 ? <p className="panel-state">还没有公开展示项。</p> : <ul className="showcase-list">{items.map((item) => <li key={item.id}><label><input type="checkbox" checked={selected.includes(item.id)} disabled={!selected.includes(item.id) && selected.length >= 3} onChange={(event) => setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />{item.title}</label><p>{item.content}</p><button type="button" onClick={() => { if (window.confirm(`确认删除“${item.title}”？`)) void onDelete(item.id); }}>删除</button></li>)}</ul>}
    <p className="selection-count">展摊已选择 {selected.length}/3 项</p>
  </div>;
}
