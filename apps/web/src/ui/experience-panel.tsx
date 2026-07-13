import type { ExperienceCard } from '@cat-house/shared';

export function ExperiencePanel({ cards, loading }: { cards: readonly ExperienceCard[]; loading: boolean }) {
  if (loading) return <p className="panel-state">正在整理旅行见闻...</p>;
  if (cards.length === 0) return <p className="panel-state">桌宠回家后，会把值得记住的小镇经历分享在这里。</p>;
  return <ul className="experience-list">{[...cards].reverse().map((card) => <li key={card.id}><h3>{card.title}</h3><p>{card.body}</p><span>{card.location}</span></li>)}</ul>;
}
