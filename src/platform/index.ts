// The only runtime access to the browser global. Return native API objects
// lazily: previews can import this module without extension APIs, and calls
// retain their original receiver, overloads, promises, callbacks and errors.
// These narrow views intentionally add no fallbacks or promise wrappers.
type StorageArea = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'setAccessLevel'>;
type Storage = { local: StorageArea; session: StorageArea; onChanged: typeof chrome.storage.onChanged };
type Tabs = Pick<typeof chrome.tabs, 'get' | 'query' | 'create' | 'update' | 'remove' | 'reload' | 'onUpdated'>;
type Scripting = Pick<typeof chrome.scripting, 'executeScript'>;
type Alarms = Pick<typeof chrome.alarms, 'create' | 'clear' | 'onAlarm'>;
type Notifications = Pick<typeof chrome.notifications, 'create'>;
type Windows = Pick<typeof chrome.windows, 'get' | 'getCurrent' | 'create' | 'update'>;
// getManifest supplies build versions for analytics and local diagnostics.
type Runtime = Pick<typeof chrome.runtime, 'sendMessage' | 'onMessage' | 'getURL' | 'id' | 'getManifest'>;
type Action = Pick<typeof chrome.action, 'onClicked'>;

export type Tab = chrome.tabs.Tab;
export type InjectionResult<T = any> = chrome.scripting.InjectionResult<T>;

export const platform = {
  get hasRuntimeId(): boolean { return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id); },
  get storage(): Storage { return chrome.storage; },
  get tabs(): Tabs { return chrome.tabs; },
  get scripting(): Scripting { return chrome.scripting; },
  get alarms(): Alarms { return chrome.alarms; },
  get notifications(): Notifications { return chrome.notifications; },
  get windows(): Windows { return chrome.windows; },
  get runtime(): Runtime { return chrome.runtime; },
  get action(): Action { return chrome.action; },
};
