import type { TownResidentState } from '@cat-house/shared';
import { Home, Map, UserRoundSearch } from 'lucide-react';

export function TownControls({ inTown, released, residents, followTarget, disabled, onRelease, onRecall, onFollow }: { inTown: boolean; released: boolean; residents: readonly TownResidentState[]; followTarget?: string; disabled?: boolean; onRelease: () => void; onRecall: () => void; onFollow: (id: string) => void }) {
  return <div className="town-controls">
    <button className="icon-button" type="button" disabled={disabled || (inTown ? !released : released)} aria-label={inTown ? '让桌宠回家' : '放桌宠去小镇'} title={inTown ? '回家' : '去小镇'} onClick={inTown ? onRecall : onRelease}>{inTown ? <Home /> : <Map />}</button>
    {inTown ? <label className="follow-control"><UserRoundSearch aria-hidden="true" /><span className="sr-only">跟随桌宠</span><select aria-label="跟随桌宠" value={followTarget ?? ''} onChange={(event) => onFollow(event.target.value)}>{residents.map((resident) => <option key={resident.residentId} value={resident.residentId}>{resident.pet.displayName}</option>)}</select></label> : null}
  </div>;
}
