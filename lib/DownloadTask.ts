import { EventEmitter } from "./events";
import { calculatePercent, isOnline } from "./utils";
import { downloaderDB, TaskMetadata } from "./storage";

export type DownloadTaskState =
  | "idle"
  | "downloading"
  | "paused"
  | "completed"
  | "error"
  | "canceled"
  | "assembling"; // New state for when combining chunks

export interface DownloadTaskProgress {
  loaded: number;
  total: number;
  percent: number;
}

// Define size for each chunk (e.g., 5MB)
const CHUNK_SIZE = 1024 * 1024 * 2;

export class DownloadTask extends EventEmitter {
  url: string;
  filename: string;
  state: DownloadTaskState = "idle";
  private xhr: XMLHttpRequest | null = null;
  private downloadedBytes = 0;
  private totalBytes = 0;
  private supportsResume = true;
  private chunkIndex = 0;

  constructor(url: string, filename: string, supportsResume = true) {
    super();
    this.url = url;
    this.filename = filename;
    this.supportsResume = supportsResume;
  }

  async start() {
    if (this.state === "downloading") return;
    this.changeState("downloading");
    this.emit("start");

    // 1. Get metadata from IndexedDB
    const metadata = await downloaderDB.getMetadata(this.url);
    if (metadata) {
      this.totalBytes = metadata.totalBytes;
      this.downloadedBytes = metadata.downloadedBytes;
      this.supportsResume = metadata.supportsResume;
      this.chunkIndex = Math.floor(this.downloadedBytes / CHUNK_SIZE);

      // Emit initial progress from saved data
      this.emitProgress();
    } else {
      // No metadata.
    }

    // 2. Start the chunking loop
    this.downloadNextChunk();
  }

  pause() {
    if (this.state !== "downloading") return;
    this.changeState("paused");
    this.emit("pause");

    if (this.xhr) {
      this.xhr.abort();
    }
  }

  resume() {
    if (this.state !== "paused") return;
    this.changeState("downloading");
    this.emit("resume");
    this.downloadNextChunk(); // Resume the loop
  }

  async cancel() {
    if (this.xhr) {
      this.xhr.abort();
    }
    this.changeState("canceled");
    this.emit("cancel");
    // Clear all data for this task
    await downloaderDB.clearMetadata(this.url);
    await downloaderDB.clearChunks(this.url);
  }

  private async downloadNextChunk() {
    if (this.state !== "downloading") return;
    if (!isOnline()) {
      this.emit("networkLost");
      this.changeState("paused");
      return;
    }

    // Check if download is already complete
    if (this.totalBytes > 0 && this.downloadedBytes >= this.totalBytes) {
      this.assembleFile();
      return;
    }

    // Calculate range for next chunk
    const startByte = this.chunkIndex * CHUNK_SIZE;
    let endByte: number | string = startByte + CHUNK_SIZE - 1;

    if (this.totalBytes > 0 && endByte >= this.totalBytes) {
      endByte = this.totalBytes - 1;
    }

    // For the last chunk, endByte might be unknown, so don't set it
    if (endByte < startByte) {
      endByte = ""; // Request all remaining bytes
    }

    this.createXHR(startByte, endByte);
  }

  private createXHR(startByte: number, endByte: number | string) {
    const xhr = new XMLHttpRequest();
    this.xhr = xhr;
    xhr.open("GET", this.url, true);
    xhr.responseType = "blob";

    // Set Range header
    if (this.supportsResume) {
      let range = `bytes=${startByte}-`;
      if (endByte !== "") {
        range += endByte;
      }
      xhr.setRequestHeader("Range", range);
    } else {
      if (startByte > 0) {
        this.handleError(
          new Error("File does not support resume, but resume was attempted."),
        );
        return;
      }
    }

    xhr.onprogress = (e: ProgressEvent) => {
      // e.loaded is the size of the *chunk* received so far
      this.downloadedBytes = startByte + e.loaded;

      // Try to get totalBytes, ONLY from Content-Range
      if (this.totalBytes === 0) {
        this.tryParseTotalBytes(xhr);
      }

      // Don't emit progress if total is unknown, it's confusing
      if (this.totalBytes > 0) {
        this.emitProgress();
      }
    };

    xhr.onload = async () => {
      // Handle non-2xx statuses as errors
      if (xhr.status < 200 || xhr.status >= 300) {
        this.handleError(new Error(`HTTP ${xhr.status} ${xhr.statusText}`));
        return;
      }

      const blob: Blob = xhr.response;

      // --- Server Resume Support Check ---
      if (xhr.status === 200 && startByte > 0) {
        // Server sent 200 OK instead of 206 Partial. It doesn't support resume.
        this.supportsResume = false;
        this.downloadedBytes = blob.size;
        this.totalBytes = blob.size;

        // We must clear old data and restart from scratch
        await downloaderDB.clearChunks(this.url);
        this.chunkIndex = 0;

        // Save this one chunk (the whole file)
        await downloaderDB.saveChunk({
          url: this.url,
          index: 0,
          blob: blob,
        });
      } else if (xhr.status === 206) {
        // This is a partial chunk, as expected.
        // We MUST get the total size from Content-Range
        if (this.totalBytes === 0) {
          this.tryParseTotalBytes(xhr);
        }

        // If we still don't have totalBytes, we have a problem.
        if (this.totalBytes === 0) {
          this.handleError(
            new Error(
              "Server did not provide Content-Range header for chunked download.",
            ),
          );
          return;
        }

        // Save the chunk
        await downloaderDB.saveChunk({
          url: this.url,
          index: this.chunkIndex,
          blob: blob,
        });

        this.downloadedBytes = startByte + blob.size;
      } else if (xhr.status === 200 && startByte === 0) {
        // This is a 200 OK for the *first* chunk.
        // This means the server sent the *whole file* at once.
        this.supportsResume = false;
        this.totalBytes = blob.size;
        this.downloadedBytes = blob.size;

        // Save this one chunk (the whole file)
        await downloaderDB.saveChunk({
          url: this.url,
          index: 0,
          blob: blob,
        });
      }

      // If the download is *not* finished, save metadata and continue
      if (this.totalBytes === 0 || this.downloadedBytes < this.totalBytes) {
        await downloaderDB.saveMetadata({
          url: this.url,
          filename: this.filename,
          totalBytes: this.totalBytes,
          downloadedBytes: this.downloadedBytes,
          supportsResume: this.supportsResume,
        });

        // Move to next chunk
        this.chunkIndex++;
        this.downloadNextChunk(); // Continue loop
      } else {
        // The download IS finished.
        // Save final metadata, then assemble.
        await downloaderDB.saveMetadata({
          url: this.url,
          filename: this.filename,
          totalBytes: this.totalBytes,
          downloadedBytes: this.downloadedBytes,
          supportsResume: this.supportsResume,
        });

        this.assembleFile();
      }
    };

    xhr.onerror = () => this.handleError(new Error("Network error"));
    xhr.onabort = () => {
      if (this.state === "paused" || this.state === "canceled") return;
      this.handleError(new Error("Aborted unexpectedly"));
    };

    xhr.send();
  }

  private tryParseTotalBytes(xhr: XMLHttpRequest) {
    const contentRange = xhr.getResponseHeader("Content-Range");
    if (contentRange) {
      // e.g., "bytes 0-5242879/12345678"
      const match = /\/(\d+)$/.exec(contentRange);
      if (match) {
        this.totalBytes = parseInt(match[1], 10);
      }
    }
  }

  private async assembleFile() {
    this.changeState("assembling");
    try {
      const chunks = await downloaderDB.getChunks(this.url);
      if (chunks.length === 0) {
        this.handleError(new Error("No chunks found to assemble."));
        return;
      }

      const fileBlob = new Blob(chunks.map((c) => c.blob));

      // Verify file size
      if (fileBlob.size !== this.totalBytes) {
        this.handleError(
          new Error(
            `Assembled file size mismatch. Expected ${this.totalBytes}, got ${fileBlob.size}`,
          ),
        );
        // Don't clear data, allow user to retry
        return;
      }

      this.changeState("completed");
      this.emit("complete", fileBlob); // Emit final assembled blob

      // Clean up
      await downloaderDB.clearMetadata(this.url);
      await downloaderDB.clearChunks(this.url);
    } catch (err) {
      this.handleError(new Error(`File assembly failed: ${err.message}`));
    }
  }

  private handleError(err: Error) {
    this.changeState("error");
    this.emit("error", err);
  }

  private changeState(newState: DownloadTaskState) {
    this.state = newState;
    this.emit("stateChange", newState);
  }

  private emitProgress() {
    const progress = {
      loaded: this.downloadedBytes,
      total: this.totalBytes,
      percent: calculatePercent(this.downloadedBytes, this.totalBytes),
    };
    this.emit("progress", progress);
  }
}
