import { BackupSummary, RollbackResult } from "../agent-backup.service";
import { AgentToolSet } from "../agent-tool";

export const PENDING_NOTE =
  "WoW is running, so the SavedVariables files were not restored yet. Close WoW, then call rollback again with the same backupId to finish them.";

export interface RecoveryDeps {
  backupService: {
    list(): Promise<BackupSummary[]>;
    rollback(id: string): Promise<RollbackResult>;
  };
}

export function createRecoveryTools(deps: RecoveryDeps): AgentToolSet {
  return {
    list_backups: async () => ({ backups: await deps.backupService.list() }),

    rollback: async (args, ctx) => {
      const backupId = typeof args.backupId === "string" ? args.backupId.trim() : "";
      if (backupId === "") {
        throw new Error("Pass backupId, from list_backups or a change result.");
      }
      ctx.progress(`Rolling back ${backupId}`);
      const result = await deps.backupService.rollback(backupId);
      return {
        backupId,
        ...result,
        ...(result.savedVariables === "pending-wow-running" ? { note: PENDING_NOTE } : {}),
      };
    },
  };
}
