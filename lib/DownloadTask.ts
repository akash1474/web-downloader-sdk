import { EventEmitter } from "./events";
import { calculatePercent, isOnline } from "./utils";
import { saveResumeData, getResumeData, clearResumeData } from "./storage";

export type DownloadTaskState =
  | "idle"
  | "downloading"
  | "paused"
  | "completed"
  | "error"
  | "canceled";

export interface DownloadTaskProgress {
  loaded: number;
  total: number;
  percent: number;
}

export class DownloadTask extends EventEmitter {
  url: string;
  filename: string;
  state: DownloadTaskState = "idle";
  private xhr: XMLHttpRequest | null = null;
  private downloadedBytes = 0;
  private totalBytes = 0;
  private supportsResume: boolean;

  constructor(url: string, filename: string, supportsResume = true) {
    super();
    this.url = url;
    this.filename = filename;
    this.supportsResume = supportsResume;
  }

  start() {
    if (this.state === "downloading") return;
    this.changeState("downloading");
    this.emit("start");
    this.createXHR();
  }

  pause() {
    if (this.state !== "downloading") return;
    if (this.xhr) this.xhr.abort();
    this.changeState("paused");
    this.emit("pause");
  }

  resume() {
    if (this.state !== "paused") return;
    this.changeState("downloading");
    this.emit("resume");
    this.createXHR(this.downloadedBytes);
  }

  cancel() {
    if (this.xhr) this.xhr.abort();
    this.changeState("canceled");
    this.emit("cancel");
  }

  private createXHR(startByte = 0) {
    if (!isOnline()) {
      this.emit("networkLost");
      this.changeState("paused");
      return;
    }

    const xhr = new XMLHttpRequest();
    this.xhr = xhr;
    xhr.open("GET", this.url, true);
    xhr.responseType = "blob";

    if (startByte > 0 && this.supportsResume) {
      xhr.setRequestHeader("Range", `bytes=${startByte}-`);
    }

    xhr.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable) {
        this.totalBytes = startByte + e.total;
        this.downloadedBytes = startByte + e.loaded;
        const progress = {
          loaded: this.downloadedBytes,
          total: this.totalBytes,
          percent: calculatePercent(this.downloadedBytes, this.totalBytes),
        };
        this.emit("progress", progress);
        saveResumeData(this.url, {
          url: this.url,
          downloadedBytes: this.downloadedBytes,
          totalBytes: this.totalBytes,
          blobParts: [],
        });
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        this.changeState("completed");
        this.emit("complete");
        this.saveBlob(xhr.response);
        clearResumeData(this.url);
      } else if (xhr.status === 206 && this.supportsResume) {
        this.changeState("completed");
        this.emit("complete");
        this.saveBlob(xhr.response);
      } else {
        this.handleError(new Error(`HTTP ${xhr.status}`));
      }
    };

    xhr.onerror = () => this.handleError(new Error("Network error"));
    xhr.onabort = () => {
      if (this.state === "paused" || this.state === "canceled") return;
      this.handleError(new Error("Aborted unexpectedly"));
    };

    xhr.send();
  }

  private saveBlob(blob: Blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = this.filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private handleError(err: Error) {
    this.changeState("error");
    this.emit("error", err);
  }

  private changeState(newState: DownloadTaskState) {
    this.state = newState;
    this.emit("stateChange", newState);
  }
}
