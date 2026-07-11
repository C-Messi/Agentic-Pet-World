import type { AgentAction, ActionResult, WorldSnapshot } from '@cat-house/shared';

export interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorldStateRecord {
  sessionId: string;
  snapshot: WorldSnapshot;
  updatedAt: string;
}

export interface EventRecord<TPayload> {
  id: string;
  sessionId: string;
  type: string;
  payload: TPayload;
  createdAt: string;
}

export type ActionRunStatus =
  | 'pending'
  | 'running'
  | ActionResult['status'];

export interface ActionRunRecord {
  id: string;
  sessionId: string;
  action: AgentAction;
  status: ActionRunStatus;
  result?: ActionResult;
  createdAt: string;
  updatedAt: string;
}
