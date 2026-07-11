/// <reference types="vite/client" />

interface Window {
  __CAT_HOUSE_E2E__?: {
    sessionId?: string;
    statuses: string[];
    phases: string[];
    bubbles: Array<{ kind: string; text?: string }>;
    actions: Array<{ phase: string; actionId: string }>;
    snapshots: Array<{
      cat: {
        position: { x: number; y: number };
        currentTargetId?: string | undefined;
      };
    }>;
    activeSceneKeys: string[];
  };
}
