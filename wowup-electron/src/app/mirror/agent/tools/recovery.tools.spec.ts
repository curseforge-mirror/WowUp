/* eslint-disable */
import { createRecoveryTools } from "./recovery.tools";

describe("recovery tools", () => {
  const ctx = () => ({ progress: jasmine.createSpy("progress") });
  const result = (savedVariables: string) => ({
    safetyBackupId: "s1",
    restoredFolders: ["Foo"],
    removedFolders: [],
    restoredRecords: 1,
    removedRecords: 0,
    savedVariables,
  });

  const make = (savedVariables = "restored") => {
    const backupService = {
      list: jasmine.createSpy("list").and.resolveTo([{ id: "b1", tool: "t", createdAt: "x", addons: ["Foo"] }]),
      rollback: jasmine.createSpy("rollback").and.resolveTo(result(savedVariables)),
    };
    return { backupService, tools: createRecoveryTools({ backupService: backupService as any }) };
  };

  it("list_backups returns the service's list", async () => {
    const { tools } = make();
    const out: any = await tools.list_backups({}, ctx());
    expect(out.backups.map((b: any) => b.id)).toEqual(["b1"]);
  });

  it("rollback needs a backupId and passes it through", async () => {
    const { backupService, tools } = make();
    await expectAsync(tools.rollback({}, ctx())).toBeRejectedWithError(/backupId/);
    const out: any = await tools.rollback({ backupId: " b1 " }, ctx());
    expect(backupService.rollback).toHaveBeenCalledWith("b1");
    expect(out.backupId).toBe("b1");
    expect(out.safetyBackupId).toBe("s1");
    expect(out.note).toBeUndefined();
  });

  it("rollback says how to finish SavedVariables left pending", async () => {
    const { tools } = make("pending-wow-running");
    const out: any = await tools.rollback({ backupId: "b1" }, ctx());
    expect(out.savedVariables).toBe("pending-wow-running");
    expect(out.note).toContain("rollback again");
  });
});
