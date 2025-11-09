import { EventEmitter } from "./events";
import { calculatePercent, isOnline } from "./utils";
import { downloaderDB, TaskMetadata } from "./storage";
// Import the new errors
import {
	DownloaderError,
	NetworkError,
	HttpError,
	UnsupportedServerErorr,
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
const DEFAULT_CHUNK_SIZE = 1024 * 1024 * 20; // 20MB (min/fallback)
const MAX_CHUNK_SIZE = 1024 * 1024 * 100; // 100MB (max)
const TARGET_CHUNK_COUNT = 100; // Aim for 100 chunks

export class DownloadTask extends EventEmitter {
	url: string;
	filename: string;
	state: DownloadTaskState = "idle";
	private xhr: XMLHttpRequest | null = null;
	private downloadedBytes = 0;
	private totalBytes = 0;
	private supportsResume = true;
	private chunkIndex = 0;
	private chunkSize = DEFAULT_CHUNK_SIZE; // Default, will be updated

	constructor(url: string, filename: string, supportsResume = true) {
		super();
		this.url = url;
		this.filename = filename;
		this.supportsResume = supportsResume;
	}

	async start() {
		if (this.state === "downloading" || this.state === "fetching_metadata") {
			return;
		}

		// 1. Get metadata from IndexedDB
		const metadata = await downloaderDB.getMetadata(this.url);
		if (metadata) {
			// --- Resuming Download ---
			this.totalBytes = metadata.totalBytes;
			this.downloadedBytes = metadata.downloadedBytes;
			this.supportsResume = metadata.supportsResume;

			this.calculateChunkSize(); // Calculate chunk size based on total

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
					err.message
				);
			}

			this.calculateChunkSize(); // Calculate based on totalBytes (even if 0)

			this.changeState("downloading");
			this.emit("start");
			this.downloadNextChunk();
		}
	}

	/**
	 * Tries to get file metadata (especially Content-Length) using a HEAD request.
	 */
	private fetchMetadata(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!isOnline()) {
				return reject(new NetworkError("Offline, cannot fetch metadata."));
			}

			const xhr = new XMLHttpRequest();
			xhr.open("HEAD", this.url, true);

			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					const length = xhr.getResponseHeader("Content-Length");
					if (length) {
						this.totalBytes = parseInt(length, 10);
					}
					// Check for 'Accept-Ranges' to confirm resume support
					this.supportsResume =
						xhr.getResponseHeader("Accept-Ranges") === "bytes";
					resolve();
				} else {
					// Server doesn't support HEAD (e.g., 405 Method Not Allowed)
					reject(new HttpError(xhr.status, xhr.statusText));
				}
			};

			xhr.onerror = () => {
				reject(new NetworkError("HEAD request failed"));
			};

			xhr.send();
		});
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
			Math.min(dynamicSize, MAX_CHUNK_SIZE)
		);
	}

	pause() {
		if (this.state !== "downloading") return;
		this.changeState("paused");
		this.emit("pause");

		if (this.xhr) {
			// Detach listeners *before* aborting
			this.xhr.onprogress = null;
			this.xhr.onload = null;
			this.xhr.onerror = null;
			this.xhr.onabort = null;

			this.xhr.abort();
			this.xhr = null;
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
			// Detach listeners *before* aborting
			this.xhr.onprogress = null;
			this.xhr.onload = null;
			this.xhr.onerror = null;
			this.xhr.onabort = null;

			this.xhr.abort();
			this.xhr = null;
		}

		// Clear all data for this task
		await downloaderDB.clearMetadata(this.url);
		await downloaderDB.clearChunks(this.url);
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
		const startByte = this.chunkIndex * this.chunkSize;
		let endByte: number | string = startByte + this.chunkSize - 1;

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

		// Add unique query params to prevent Keep-Alive race conditions.
		const url = new URL(this.url);
		url.searchParams.set("dl_chunk", this.chunkIndex.toString());
		url.searchParams.set("dl_ts", Date.now().toString());

		xhr.open("GET", url.href, true);
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
					new UnsupportedServerErorr(
						"File does not support resume, but resume was attempted."
					)
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
					// Recalculate chunk size now that we know the total
					this.calculateChunkSize();
				}
			}

			if (this.totalBytes > 0) {
				this.emitProgress();
			}
		};

		xhr.onload = async () => {
			// Handle non-2xx statuses as errors
			if (xhr.status < 200 || xhr.status >= 300) {
				this.handleError(new HttpError(xhr.status, xhr.statusText));
				this.xhr = null; // Clean up
				return;
			}

			const blob: Blob = xhr.response;
			let wasFirstChunk = false;

			try {
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
						const discoveredTotal = this.tryParseTotalBytes(xhr);
						if (discoveredTotal > 0) {
							this.totalBytes = discoveredTotal;
							wasFirstChunk = true;
						} else {
							this.handleError(
								new UnsupportedServerErorr(
									"Server did not provide Content-Range header for chunked download."
								)
							);
							this.xhr = null; // Clean up
							return;
						}
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
					wasFirstChunk = true;

					// Save this one chunk (the whole file)
					await downloaderDB.saveChunk({
						url: this.url,
						index: 0,
						blob: blob,
					});
				}
			} catch (err) {
				// Handle Quota Error
				if (err instanceof DOMException && err.name === "QuotaExceededError") {
					this.handleError(new QuotaError());
				} else {
					this.handleError(new DownloaderError(err.message));
				}
				this.xhr = null; // Clean up
				return;
			}

			// If this was the first chunk and we just found the total size,
			// we must recalculate the chunk size for subsequent requests.
			if (wasFirstChunk) {
				this.calculateChunkSize();
			}

			// Clean up XHR reference
			this.xhr = null;

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

		xhr.onerror = () => {
			this.handleError(new NetworkError());
			this.xhr = null; // Clean up
		};

		xhr.onabort = () => {
			// This check is now safe, as pause/cancel will detach it.
			// This will only run for *truly* unexpected aborts.
			if (this.state === "paused" || this.state === "canceled") return;
			this.handleError(new NetworkError("Aborted unexpectedly"));
			this.xhr = null; // Clean up
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
			const chunks = await downloaderDB.getChunks(this.url);
			if (chunks.length === 0) {
				this.handleError(new AssemblyError("No chunks found to assemble."));
				return;
			}

			const fileBlob = new Blob(chunks.map((c) => c.blob));

			// Verify file size
			if (this.totalBytes > 0 && fileBlob.size !== this.totalBytes) {
				this.handleError(
					new AssemblyError(
						`Assembled file size mismatch. Expected ${this.totalBytes}, got ${fileBlob.size}`
					)
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
			this.handleError(
				new AssemblyError(`File assembly failed: ${err.message}`)
			);
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
