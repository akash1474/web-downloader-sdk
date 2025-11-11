## 🏗️ High-Level Architecture

The SDK is built on a clean, event-driven architecture that separates responsibilities into distinct classes.

Think of it as a professional kitchen:

- **`DownloadManager` :** This is the **Public API**. Your application (`main.ts`) gives high-level commands (e.g., "start this job") to the manager.
- **`DownloaderQueue` :** The manager's private assistant. It ensures the kitchen doesn't get overwhelmed by managing a **concurrency limit** (e.g., only 2 "dishes" or downloads at a time).
- **`DownloadJob` :** A container that groups tasks (e.g., "download a zip and its text file"). Its main purpose is to **aggregate progress** from all its tasks into one "Overall Job Progress" bar.
- **`DownloadTask` :** The **workhorse** of the entire system. It is an expert at downloading *one single file*. It knows how to use `HEAD` requests, download in chunks, pause, resume, and handle any error for that file.
- **`storage.ts` :** The `IndexedDB` wrapper used by the `DownloadTask` to store downloaded chunks and metadata, making resume-after-refresh possible.

------

## 🚀 Architectural Flow (Step-by-Step)

This is how the components interact from a user click to a completed download:

1. **UI (`main.ts`):** A user clicks "Start Job".
2. **`main.ts`** calls `manager.createJob(...)`.
3. **`DownloadManager`** creates a `new DownloadJob(...)`.
4. **`DownloadJob`** (in its constructor) creates all its `DownloadTask` instances, which sit in an "idle" state.
5. **`main.ts`** calls `manager.startJob(job)`.
6. **`DownloadManager`** loops through the job's tasks and adds them one-by-one to its internal **`DownloaderQueue`**.
7. **`DownloaderQueue`** (now running) pulls tasks from its queue, respecting the concurrency limit. It is the *only* component that calls `task.start()`.
8. **`DownloadTask`** takes over:
    - It checks `IndexedDB` for resume data.
    - If no data exists, it fires a `HEAD` request to get the file size.
    - It calculates an optimal chunk size (e.g., 30MB).
    - It starts its download loop (`downloadNextChunk`), fetching chunks one by one
    - After each chunk downloads, it saves it to `IndexedDB`.
    - When all chunks are done, it assembles the final blob and emits `"complete"`.
9. **Events Flow Up:**
    - As the `DownloadTask` emits `"progress"`, the `DownloadJob` listens, recalculates the *total* job progress, and emits its *own* `"progress"` event.
    - The `main.ts` UI listens to *both* `task.on("progress")` (for the file bar) and `job.on("progress")` (for the overall bar).
    - When the `DownloadTask` emits `"complete"`, the `DownloaderQueue` frees up a slot and starts the next task. The `DownloadJob` marks the task as complete and, when all tasks are done, emits its *own* `"complete"` event.

------

## ## 📋 Class & Method Details

Here is a detailed breakdown of each class in the SDK.

### `DownloadManager`

**(File: `DownloadManager.ts`)** The main public API for the SDK. It coordinates jobs and the queue.

- `constructor(concurrency = 2)`: Initializes the manager and creates its internal `DownloaderQueue` with the specified concurrency.
- `createJob(urls, filenames)`: Creates a new `DownloadJob` instance and attaches event listeners to bubble up events.
- `startJob(job)`: Adds all tasks from a given job to the download queue.
- `pauseJob(job)`: Calls `.pause()` on every task in that job.
- `resumeJob(job)`: Adds any "paused" tasks from that job back into the queue to be resumed.
- `cancelJob(job)`: Calls `.cancel()` on every task in that job.
- `pauseAll()`: Pauses the entire `DownloaderQueue`, which in turn pauses all active downloads.
- `resumeAll()`: Resumes the `DownloaderQueue`.
- `attachJobEvents(job)` (private): Wires up listeners to bubble events from a `DownloadJob` (like `jobProgress`, `taskComplete`) to the manager instance.
- `attachQueueEvents()` (private): Bubbles events from the `DownloaderQueue` (like `queueStart`, `queueEmpty`) to the manager.



### `DownloaderQueue`

**(File: `DownloaderQueue.ts`)** Manages download concurrency. It acts as a "gate" to ensure only a set number of tasks run at once.

- `constructor(concurrency = 2)`: Sets the maximum number of active downloads.
- `add(task)`: Adds a `DownloadTask` to the waiting list (`this.queue`).
- `start()`: Sets the queue state to `running` and calls `run()` to start processing.
- `pause()`: Sets the `running` flag to `false` and pauses all currently active tasks.
- `clear()`: Clears the waitlist and cancels all active downloads.
- `run()` (private): The core logic. It's a `while` loop that pulls tasks from `this.queue` and moves them to `this.active` as long as the concurrency limit isn't hit. It is the *only* class that calls `task.start()`.



### `DownloadJob`

**(File: `DownloadJob.ts`)** A container for a group of `DownloadTask`s. Its primary role is to aggregate progress.

- `constructor(urls, filenames)`: Creates all `DownloadTask` instances for the job and sets up an internal `taskProgress` map to store the latest progress for each.
- `attachTaskEvents()` (private): The main logic.
    - It listens to `task.on("progress")` for *every* task.
    - When one fires, it updates its internal map and **recalculates the total percentage** for the *entire job* (sum of all loaded bytes / sum of all total bytes).
    - It then emits its own `progress` event with this aggregate data.
    - It also listens to `task.on("complete")` to count finished tasks and emit a job-level `complete` event when all are done.



### `DownloadTask`

**(File: `DownloadTask.ts`)** The most complex class. It handles the logic for downloading a single file.

- `constructor(url, filename)`: Initializes the task with its file details.
- `start()`: The main entry point. It checks `IndexedDB` for resume data. If found, it resumes. If not, it calls `fetchMetadata()` to start a new download.
- `pause()`: Sets the state to `"paused"`, detaches all XHR listeners to prevent race conditions, and aborts the current `xhr`.
- `resume()`: Sets the state to `"downloading"` and calls `downloadNextChunk()` to restart the download loop.
- `cancel()`: Sets the state to `"canceled"`, aborts the `xhr`, and triggers a full cleanup of metadata and chunks from `IndexedDB`.
- `fetchMetadata()` (private): Performs a `HEAD` request to get `Content-Length` and `Accept-Ranges` headers, which are used to set `this.totalBytes` and `this.supportsResume`.
- `calculateChunkSize()` (private): Calculates the optimal chunk size, clamped between 20MB and 100MB, aiming for ~100 chunks total.
- `downloadNextChunk()` (private): The core loop. Checks if the download is complete. If not, it calculates the byte range for the next chunk and calls `createXHR`.
- `createXHR(startByte, endByte)` (private): The low-level worker. It creates an `XMLHttpRequest`, adds cache-busting parameters to the URL to prevent network errors, sets the `Range` header, and wires up the `onload`, `onprogress`, and `onerror` handlers.
- `tryParseTotalBytes(xhr)` (private): A helper to read the `Content-Range` header. This is the fallback for when the `HEAD` request fails.
- `assembleFile()` (private): Called when the download is complete. It fetches all `TaskChunk` blobs from `IndexedDB`, combines them into a single final `Blob`, verifies the size, emits the `"complete"` event, and cleans up the database.
- `handleError(err)` (private): Emits a formal error event.
- `changeState(newState)` (private): Updates the `this.state` property and emits a `"stateChange"` event.
- `emitProgress()` (private): Emits the `"progress"` event with formatted percentage and byte counts.



### `storage.ts`

**(File: `storage.ts`)** A simple singleton class that wraps the `idb` library to provide a clean, promise-based API for `IndexedDB`.

- `constructor()`: Calls `openDB` to initialize the database and create the `taskMetadata` and `taskChunks` object stores if they don't exist.
- `getMetadata(url)`, `saveMetadata(metadata)`, `clearMetadata(url)`: Standard CRUD (Create/Read/Delete) methods for the `taskMetadata` store.
- `saveChunk(chunk)`, `getChunks(url)`, `clearChunks(url)`: CRUD methods for the `taskChunks` store. `getChunks` notably reads all chunks for a URL and sorts them by index.
- `clearAllData()`: A helper to completely wipe the database.



### `events.ts`, `errors.ts`, `utils.ts`

These are simple, stateless utilities that support the main architecture.

- **`events.ts`:** Provides the `EventEmitter` base class with `on`, `off`, `emit`, and `clear` methods.
- **`errors.ts`:** Defines the custom error classes (`DownloaderError`, `NetworkError`, `HttpError`, `UnsupportedServerErorr`, `AssemblyError`, `QuotaError`) so the UI can use `instanceof` to identify and handle different failure types.
- **`utils.ts`:** Contains helper functions `calculatePercent`, `isOnline`, and `wait`.