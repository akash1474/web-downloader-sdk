export interface ResumeData {
  url: string;
  downloadedBytes: number;
  totalBytes: number;
  blobParts: Blob[];
}

const resumeMap = new Map<string, ResumeData>();

export function saveResumeData(url: string, data: ResumeData) {
  resumeMap.set(url, data);
}

export function getResumeData(url: string): ResumeData | undefined {
  return resumeMap.get(url);
}

export function clearResumeData(url: string) {
  resumeMap.delete(url);
}

export function clearAllResumeData() {
  resumeMap.clear();
}
