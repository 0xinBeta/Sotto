import {
  NotesReminderStore,
  type AlarmStoreLike,
  type StorageAreaLike,
} from "@sotto/actions/notes/storage";
import {
  restrictNotesStorageAccess as restrictStorageAccess,
} from "@sotto/actions/notes/storage-access";

const localStorage = chrome.storage.local;
const alarmApi = chrome.alarms;

const storage: StorageAreaLike = {
  get: async (keys) => {
    if (keys === undefined) return localStorage.get(null);
    return localStorage.get(keys as string | string[] | null);
  },
  set: async (items) => await localStorage.set(items),
  remove: async (keys) =>
    await localStorage.remove(keys as string | string[]),
};

const alarms: AlarmStoreLike = {
  get: async (name) => await alarmApi.get(name),
  getAll: async () => await alarmApi.getAll(),
  create: async (name, alarmInfo) =>
    await alarmApi.create(name, alarmInfo),
  clear: async (name) => await alarmApi.clear(name),
};

export const notesReminderStore = new NotesReminderStore({
  storage,
  alarms,
});

export async function restrictNotesStorageAccess(): Promise<void> {
  await restrictStorageAccess(localStorage);
}
