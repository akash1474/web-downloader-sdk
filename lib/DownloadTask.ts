import { EventEmitter } from "./events";
import { calculatePercent, isOnline } from "./utils";
import { downloadStorage } from "./storage";
// Import the new errors
import {
  DownloaderError,
  NetworkError,
  HttpError,
  UnsupportedServerError,
  AssemblyError,
  QuotaError,
} from "./errors";

export type DownloadTaskState =
  | "idle"
  | "downloading"
  | "paused"
  | "completed"
  | "error"
  | "canceled"
  | "assembling"
  | "fetching_metadata"; // New state

export interface DownloadTaskProgress {
  loaded: number;
  total: number;
  percent: number;
}

// --- Dynamic Chunk Size Constants (UPDATED) ---
const DEFAULT_CHUNK_SIZE = 1024 * 1024 * 10; // 5MB (min/fallback)
const MAX_CHUNK_SIZE = 1024 * 1024 * 100; // 100MB (max)
const TARGET_CHUNK_COUNT = 50; // Aim for 100 chunks

export class DownloadTask extends EventEmitter {
  url: string;
  filename: string;
  state: DownloadTaskState = "idle";
  private xhr: XMLHttpRequest | null = null;
  private downloadedBytes = 0;
  private totalBytes = 0;
  private supportsResume = false;
  private chunkIndex = 0;
  private chunkSize = DEFAULT_CHUNK_SIZE; // Default, will be updated
  private retryCount = 0;
  private maxRetries = 3;
  private retryDelay = 1000;

  constructor(url: string, filename: string) {
    super();
    this.url = url;
    this.filename = filename;
  }

  async start() {
    if (this.state === "downloading" || this.state === "fetching_metadata") {
      return;
    }

    // 1. Get metadata from IndexedDB
    const metadata = await downloadStorage.getMetadata(this.url);
    if (metadata) {
      // --- Resuming Download ---
      this.totalBytes = metadata.totalBytes;
      this.downloadedBytes = metadata.downloadedBytes;
      this.supportsResume = metadata.supportsResume;
      this.chunkSize = metadata.chunkSize;
      this.chunkIndex = Math.floor(this.downloadedBytes / this.chunkSize);

      this.emitProgress();
      this.changeState("downloading");
      this.emit("start");
      this.downloadNextChunk();
    } else {
      // --- New Download: First, get metadata ---
      this.changeState("fetching_metadata");
      try {
        await this.fetchMetadata();
        // fetchMetadata will set this.totalBytes if successful
      } catch (err) {
        // HEAD request failed or not supported.
        // We will proceed and try to get size from the first GET.
        console.warn(
          "HEAD request failed, falling back to GET for metadata.",
          err.message,
        );
      }

      this.calculateChunkSize(); // Calculate based on totalBytes (even if 0)

      this.changeState("downloading");
      this.emit("start");
      this.downloadNextChunk();
    }
  }

  /**
   * Tries to get file metadata (Content-Length/Range) using HEAD.
   * Falls back to a "Probe" GET request (first byte) if HEAD fails.
   */
  private fetchMetadata(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!isOnline()) {
        return reject(new NetworkError("Offline, cannot fetch metadata."));
      }

      // Strategy 1: Try HEAD first (Fastest)
      const xhr = new XMLHttpRequest();
      xhr.open("HEAD", this.url, true);

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          this.handleMetadataSuccess(xhr);
          resolve();
        } else {
          // HEAD failed (e.g. 405 Method Not Allowed).
          // Switch to Strategy 2: Probe Request
          console.warn("HEAD failed, trying Range Probe...");
          this.fetchMetadataProbe().then(resolve).catch(reject);
        }
      };

      xhr.onerror = () => {
        // Network error on HEAD (could be CORS). Try Probe as backup.
        console.warn("HEAD error, trying Range Probe...");
        this.fetchMetadataProbe().then(resolve).catch(reject);
      };

      xhr.send();
    });
  }

  /**
   * Sends a GET request for a single byte to "probe" the server capabilities.
   */
  private fetchMetadataProbe(): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", this.url, true);
      // Request just the first byte
      xhr.setRequestHeader("Range", "bytes=0-0");

      // CRITICAL: Watch for headers to arrive so we can abort 200 OK immediately
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 2) {
          // HEADERS_RECEIVED
          if (xhr.status === 200) {
            // Server ignored Range header and is sending the whole file!
            // Abort immediately to prevent downloading 10GB.
            console.warn("Server ignored Range (200 OK). Aborting probe.");
            xhr.abort();

            // We know resume is NOT supported.
            this.supportsResume = false;

            // Try to get length from normal header
            this.handleMetadataSuccess(xhr);

            resolve(); // Resolve successfully (we just fall back to single-stream)
          }
        }
      };

      xhr.onload = () => {
        // If we get here, it's likely a 206 Partial Content (Success)
        if (xhr.status === 206) {
          this.handleMetadataSuccess(xhr);
          resolve();
        } else {
          // Any other status (404, 500, etc) is a real error
          reject(new HttpError(xhr.status, xhr.statusText));
        }
      };

      xhr.onerror = () => reject(new NetworkError("Probe request failed"));

      xhr.send();
    });
  }

  /**
   * Helper to extract data from a successful XHR (HEAD or 206 Probe)
   */
  private handleMetadataSuccess(xhr: XMLHttpRequest) {
    const length = xhr.getResponseHeader("Content-Length");
    if (length) {
      this.totalBytes = parseInt(length, 10);
    }

    // If Content-Length was missing or misleading (common in Range responses),
    // try Content-Range
    const rangeTotal = this.tryParseTotalBytes(xhr);
    if (rangeTotal > 0) {
      this.totalBytes = rangeTotal;
    }

    // Check resume support
    this.supportsResume =
      xhr.status === 206 || xhr.getResponseHeader("Accept-Ranges") === "bytes";
  }

  /**
   * Calculates and sets the optimal chunk size based on total file size.
   */
  private calculateChunkSize() {
    if (this.totalBytes <= 0) {
      this.chunkSize = DEFAULT_CHUNK_SIZE;
      return;
    }

    const dynamicSize = Math.ceil(this.totalBytes / TARGET_CHUNK_COUNT);

    // Clamp between DEFAULT (min) and MAX
    this.chunkSize = Math.max(
      DEFAULT_CHUNK_SIZE,
      Math.min(dynamicSize, MAX_CHUNK_SIZE),
    );

    console.log(`Chunk Size:${this.chunkSize / (1024 * 1024)}MB`);
  }

  pause() {
    if (this.state !== "downloading") return;
    this.changeState("paused");
    this.emit("pause");

    if (this.xhr) {
      const currentXhr = this.xhr;
      this.xhr = null;

      // Then detach listeners and abort
      currentXhr.onprogress = null;
      currentXhr.onload = null;
      currentXhr.onerror = null;
      currentXhr.onabort = null;
      currentXhr.abort();
    }
  }

  resume() {
    if (this.state !== "paused") return;
    this.changeState("downloading");
    this.emit("resume");
    this.downloadNextChunk(); // Resume the loop
  }

  async cancel() {
    this.changeState("canceled"); // Set state first
    this.emit("cancel");

    if (this.xhr) {
      // Detach listeners before aborting
      const currentXhr = this.xhr;
      this.xhr = null;

      // Then detach listeners and abort
      currentXhr.onprogress = null;
      currentXhr.onload = null;
      currentXhr.onerror = null;
      currentXhr.onabort = null;
      currentXhr.abort();
    }

    // Clear all data for this task
    await downloadStorage.clearMetadata(this.url);
    await downloadStorage.clearChunks(this.url);
  }

  private async downloadNextChunk() {
    if (this.state !== "downloading") return;

    if (!isOnline()) {
      this.emit("networkLost");
      // Don't error out, just pause.
      this.changeState("paused");
      return;
    }

    // Check if download is already complete
    if (this.totalBytes > 0 && this.downloadedBytes >= this.totalBytes) {
      this.assembleFile();
      return;
    }

    // Calculate range for next chunk
    // Calculate the byte range for the HTTP Range header.
    // Byte ranges are inclusive and 0-based, just like array indices.
    const startByte = this.chunkIndex * this.chunkSize;
    let endByte: number = startByte + this.chunkSize - 1;

    if (this.totalBytes > 0 && endByte >= this.totalBytes) {
      //clamp the chunk's end byte to the file's end
      // byte, which is necessary for the final partial chunk.
      endByte = this.totalBytes - 1;
    }

    this.createXHR(startByte, endByte);
  }

  private createXHR(startByte: number, endByte: number) {
    const xhr = new XMLHttpRequest();
    this.xhr = xhr;

    // Add unique query params to prevent Keep-Alive race conditions.
    const url = new URL(this.url);
    // Add a cache-busting query parameter
    url.searchParams.set("_t", Date.now().toString());

    xhr.open("GET", url.href, true);
    xhr.responseType = "blob";

    // Set Range header
    if (this.supportsResume) {
      let range = `bytes=${startByte}-${endByte}`;
      xhr.setRequestHeader("Range", range);
    } else {
      if (startByte > 0) {
        this.handleError(
          new UnsupportedServerError(
            "File does not support resume, but resume was attempted.",
          ),
        );
        return;
      }
    }

    xhr.onprogress = (e: ProgressEvent) => {
      this.downloadedBytes = startByte + e.loaded;

      // Try to get totalBytes, ONLY from Content-Range (if not known)
      if (this.totalBytes === 0) {
        const discoveredTotal = this.tryParseTotalBytes(xhr);
        if (discoveredTotal > 0) {
          this.totalBytes = discoveredTotal;
        }
      }

      if (this.totalBytes > 0) {
        this.emitProgress();
      }
    };

    xhr.onload = async () => {
      // Handle non-2xx statuses
      if (xhr.status >= 500) {
        // Server errors (500, 503, etc.)
        this._handleRetryableError(new HttpError(xhr.status, xhr.statusText)); // RETRY
        return;
      }
      if (xhr.status >= 300) {
        // Other errors (3xx redirect, 4xx client error)
        this.handleError(new HttpError(xhr.status, xhr.statusText)); // FAIL
        this.xhr = null;
        return;
      }

      const blob: Blob = xhr.response;

      try {
        // --- Server Resume Support Check ---
        if (xhr.status === 200 && startByte > 0) {
          console.log(
            "⚠️ Server doesn't support resume (200 OK for non-zero start)",
          );
          // Server sent 200 OK instead of 206 Partial. It doesn't support resume.
          this.supportsResume = false;
          this.downloadedBytes = blob.size;
          this.totalBytes = blob.size;

          // We must clear old data and restart from scratch
          await downloadStorage.clearChunks(this.url);
          this.chunkIndex = 0;
          // Save this one chunk (the whole file)
          await downloadStorage.saveChunk({
            url: this.url,
            index: 0,
            blob: blob,
          });
          this.retryCount = 0;
        } else if (xhr.status === 206) {
          // This is a partial chunk, as expected.
          // We MUST get the total size from Content-Range
          if (this.totalBytes === 0) {
            const discoveredTotal = this.tryParseTotalBytes(xhr);
            if (discoveredTotal > 0) {
              this.totalBytes = discoveredTotal;
            } else {
              console.error("❌ No Content-Range header found");
              this.handleError(
                new UnsupportedServerError(
                  "Server did not provide Content-Range header for chunked download.",
                ),
              );
              this.xhr = null; // Clean up
              return;
            }
          }

          // Save the chunk
          await downloadStorage.saveChunk({
            url: this.url,
            index: this.chunkIndex,
            blob: blob,
          });

          this.retryCount = 0;
          this.downloadedBytes = startByte + blob.size;
        } else if (xhr.status === 200 && startByte === 0) {
          // This is a 200 OK for the *first* chunk.
          // This means the server sent the *whole file* at once.
          this.supportsResume = false;
          this.totalBytes = blob.size;
          this.downloadedBytes = blob.size;

          // Save this one chunk (the whole file)
          await downloadStorage.saveChunk({
            url: this.url,
            index: 0,
            blob: blob,
          });
          this.retryCount = 0;
        }
      } catch (err) {
        console.error("❌ Error saving chunk:", err);
        // Handle Quota Error
        if (err instanceof DOMException && err.name === "QuotaExceededError") {
          this.handleError(new QuotaError());
        } else {
          this.handleError(new DownloaderError(err.message));
        }
        this.xhr = null; // Clean up
        return;
      }

      // Clean up XHR reference
      this.xhr = null;

      // If the download is not finished, save metadata and continue
      if (this.totalBytes === 0 || this.downloadedBytes < this.totalBytes) {
        await downloadStorage.saveMetadata({
          url: this.url,
          filename: this.filename,
          totalBytes: this.totalBytes,
          downloadedBytes: this.downloadedBytes,
          supportsResume: this.supportsResume,
          chunkSize: this.chunkSize,
        });

        // Move to next chunk
        this.chunkIndex++;
        this.downloadNextChunk(); // Continue loop
      } else {
        console.log("🎉 Download complete! Assembling file...");
        // The download IS finished - save final metadata, then assemble.
        await downloadStorage.saveMetadata({
          url: this.url,
          filename: this.filename,
          totalBytes: this.totalBytes,
          downloadedBytes: this.downloadedBytes,
          supportsResume: this.supportsResume,
          chunkSize: this.chunkSize,
        });

        this.assembleFile();
      }
    };

    xhr.onerror = () => {
      this._handleRetryableError(new NetworkError());
    };

    xhr.onabort = () => {
      // This check is now safe, as pause/cancel will detach it.
      // This will only run for truly unexpected aborts.
      if (this.state === "paused" || this.state === "canceled") return;
      this.handleError(new NetworkError("Aborted unexpectedly"));
      this.xhr = null;
    };

    xhr.send();
  }

  private tryParseTotalBytes(xhr: XMLHttpRequest): number {
    const contentRange = xhr.getResponseHeader("Content-Range");
    if (contentRange) {
      // e.g., "bytes 0-5242879/12345678"
      const match = /\/(\d+)$/.exec(contentRange);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
    return 0;
  }

  private async assembleFile() {
    this.changeState("assembling");
    try {
      const chunks = await downloadStorage.getChunks(this.url);

      // 1. Check if we have chunks at all
      if (chunks.length === 0) {
        this.handleError(new AssemblyError("No chunks found to assemble."));
        return;
      }

      // 2. INTEGRITY CHECK: Verify we have no "holes" in the chunks
      // Since we sorted them in storage, index 0 should be 0, index 1 should be 1...
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].index !== i) {
          throw new Error(
            `Missing chunk at index ${i}. Found index ${chunks[i].index} instead.`,
          );
        }
      }

      // 3. Create the Blob (This is where OOM happens for large files)
      const fileBlob = new Blob(chunks.map((c) => c.blob));

      // 4. Verify size
      if (this.totalBytes > 0 && fileBlob.size !== this.totalBytes) {
        this.handleError(
          new AssemblyError(
            `Assembled file size mismatch. Expected ${this.totalBytes}, got ${fileBlob.size}`,
          ),
        );
        // Don't return here, ensure cleanup runs
        await downloadStorage.clearMetadata(this.url);
        await downloadStorage.clearChunks(this.url);
        return;
      }

      this.changeState("completed");
      this.emit("complete", fileBlob);

      // Clean up
      await downloadStorage.clearMetadata(this.url);
      await downloadStorage.clearChunks(this.url);
    } catch (err) {
      // LOG THE ACTUAL ERROR to see if it's memory related
      console.error("Critical Assembly Error:", err);

      this.handleError(
        new AssemblyError(`File assembly failed: ${err.message}`),
      );
      // Ensure cleanup happens even on error
      await downloadStorage.clearMetadata(this.url);
      await downloadStorage.clearChunks(this.url);
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

  private async _handleRetryableError(error: Error) {
    this.xhr = null; // Clean up XHR ref

    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      // Exponential backoff
      const delay = this.retryDelay * Math.pow(2, this.retryCount - 1);

      console.warn(
        `DownloadTask: ${error.message}. Retrying in ${delay}ms... (Attempt ${this.retryCount}/${this.maxRetries})`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));

      // Check state again in case it was paused/canceled during the delay
      if (this.state === "downloading") {
        this.downloadNextChunk(); // Retry
      }
    } else {
      console.error(
        `DownloadTask: Retries exhausted for ${this.url}. ${error.message}`,
      );
      this.handleError(error);
    }
  }
}
