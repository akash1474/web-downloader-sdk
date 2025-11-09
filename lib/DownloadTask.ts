import { EventEmitter } from "./events";
import { calculatePercent, isOnline } from "./utils";
import {
  saveResumeData,
  getResumeData,
  clearResumeData,
  ResumeData,
} from "./storage";

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

    // Check for resume data
    if (this.supportsResume) {
      const resumeData = getResumeData(this.url);
      if (resumeData) {
        this.downloadedBytes = resumeData.downloadedBytes;
        this.totalBytes = resumeData.totalBytes;
      }
    }

    this.createXHR(this.downloadedBytes);
  }

  pause() {
    if (this.state !== "downloading") return;
    if (this.xhr) {
      this.xhr.abort();
    }
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
    if (this.xhr) {
      this.xhr.abort();
    }
    this.changeState("canceled");
    this.emit("cancel");
    clearResumeData(this.url);
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
        let total = e.total;
        let loaded = e.loaded;

        // If we requested a range, the server *should* send a 206
        // and e.total will be the *remaining* size.
        if (startByte > 0 && xhr.status === 206) {
          total = this.totalBytes; // Use the total from the first request
          loaded = startByte + e.loaded;
        } else {
          // This is a fresh download (or server ignored range)
          this.totalBytes = e.total;
        }

        this.downloadedBytes = loaded;

        const progress = {
          loaded: this.downloadedBytes,
          total: this.totalBytes,
          percent: calculatePercent(this.downloadedBytes, this.totalBytes),
        };
        this.emit("progress", progress);

        if (this.supportsResume) {
          saveResumeData(this.url, {
            url: this.url,
            downloadedBytes: this.downloadedBytes,
            totalBytes: this.totalBytes,
          });
        }
      }
    };

    xhr.onload = () => {
      // 206 Partial Content: Successful resume
      if (xhr.status === 206) {
        this.handleSuccess(xhr.response);
      }
      // 200 OK: Full file
      else if (xhr.status === 200) {
        // Server sent full file. If we were trying to resume,
        // it means the server doesn't support it or the file changed.
        if (startByte > 0) {
          console.warn(
            `Server sent 200 OK for a range request. Treating as full download.`,
          );
          this.downloadedBytes = xhr.response.size;
          this.totalBytes = xhr.response.size;
        }
        this.handleSuccess(xhr.response);
      }
      // Other 2xx statuses
      else if (xhr.status >= 200 && xhr.status < 300) {
        this.handleSuccess(xhr.response);
      }
      // Error
      else {
        this.handleError(new Error(`HTTP ${xhr.status} ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => this.handleError(new Error("Network error"));
    xhr.onabort = () => {
      // Don't emit error if it was a user-initiated pause or cancel
      if (this.state === "paused" || this.state === "canceled") return;
      this.handleError(new Error("Aborted unexpectedly"));
    };

    xhr.send();
  }

  private handleSuccess(blob: Blob) {
    this.changeState("completed");
    // Emit the blob so the consumer can decide what to do
    this.emit("complete", blob);
    clearResumeData(this.url);
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
