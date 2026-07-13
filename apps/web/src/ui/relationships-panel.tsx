import type { TownRelationship, TownResidentState } from '@cat-house/shared';

export function RelationshipsPanel({ relationships, residents, loading }: { relationships: readonly TownRelationship[]; residents: readonly TownResidentState[]; loading: boolean }) {
  if (loading) return <p className="panel-state">正在加载关系...</p>;
  if (relationships.length === 0) return <p className="panel-state">还没有关系记录。去认识小镇常驻居民吧。</p>;
  const names = new Map(residents.map((resident) => [resident.residentId, resident.pet.displayName]));
  return <ul className="town-list">{relationships.map((relationship) => <li key={`${relationship.residentIdA}:${relationship.residentIdB}`}><strong>{names.get(relationship.residentIdA) ?? relationship.residentIdA} × {names.get(relationship.residentIdB) ?? relationship.residentIdB}</strong><span>亲密度 {Math.round((relationship.affinity + 1) * 50)}%</span></li>)}</ul>;
}
