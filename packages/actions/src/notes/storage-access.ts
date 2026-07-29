export interface NotesStorageAccessArea {
  setAccessLevel(options: {
    readonly accessLevel: "TRUSTED_CONTEXTS";
  }): Promise<void>;
}

export async function restrictNotesStorageAccess(
  storage: NotesStorageAccessArea,
): Promise<void> {
  await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}
