export interface ResumeData {
  url: string;
  downloadedBytes: number;
  totalBytes: number;
}

const STORAGE_KEY = "downloaderSDK_resumeData";

function getStore(): Map<string, ResumeData> {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (data) {
      return new Map(JSON.parse(data));
    }
  } catch (e) {
    console.error("Failed to parse resume data from localStorage", e);
  }
  return new Map();
}

function saveStore(store: Map<string, ResumeData>) {
  try {
    const data = JSON.stringify(Array.from(store.entries()));
    localStorage.setItem(STORAGE_KEY, data);
  } catch (e) {
    console.error("Failed to save resume data to localStorage", e);
  }
}

export function saveResumeData(url: string, data: ResumeData) {
  const store = getStore();
  store.set(url, data);
  saveStore(store);
}

export function getResumeData(url: string): ResumeData | undefined {
  const store = getStore();
  return store.get(url);
}

export function clearResumeData(url: string) {
  const store = getStore();
  store.delete(url);
  saveStore(store);
}

export function clearAllResumeData() {
  localStorage.removeItem(STORAGE_KEY);
}
