## 🏗️ High-Level Architecture

The SDK is built on a clean, event-driven architecture that separates responsibilities into distinct classes.

Think of it as a professional kitchen:

- **`DownloadManager` :** This is the **Public API**. Your application (`main.ts`) gives high-level commands (e.g., "start this job") to the manager.
- **`DownloaderQueue` :** The manager's private assistant. It ensures the kitchen doesn't get overwhelmed by managing a **concurrency limit** (e.g., only 2 downloads at a time).
- **`DownloadJob` :** A container that groups tasks (e.g., "download a zip and its text file"). Its main purpose is to **aggregate progress** from all its tasks into one "Overall Job Progress" bar.
- **`DownloadTask` :** The **workhorse** of the entire system. It is an expert at downloading *one single file*. It knows how to use `HEAD` requests, download in chunks, pause, resume, handle network retries, and manage any error for that file.
- **`storage.ts` :** The `IndexedDB` wrapper (using the `idb` library) used by the `DownloadTask` to store downloaded chunks and metadata, making resume-after-refresh possible.

```cpp
[ main.ts (UI) ]
    |
    | .createJob(), .startJob()
    | .on("jobProgress"), .on("taskError")
    V
[ DownloadManager ]  <-- (Owns) -->  [ DownloaderQueue ]
    |                                      |
    | .on("progress"), .on("complete")       | .add(task), .start()
    |                                      |
    V                                      V
[ DownloadJob ]                            [ DownloadTask ]
    |                                      |
    | .on("progress"), .on("complete")       | .start()
    |                                      V
    `--(Owns)--> [ DownloadTask ]  <-----> [ storage.ts (IndexedDB) ]
    |
    `--(Owns)--> [ DownloadTask ]
    |
    `--(Owns)--> [ DownloadTask ]
```

------

### 📊 Architecture Diagram



Here's a simple diagram of the component hierarchy and event flow:

```
[ main.ts (UI) ]
    |
    | .createJob(), .startJob()
    | .on("jobProgress"), .on("taskError")
    V
[ DownloadManager ]  <-- (Owns) -->  [ DownloaderQueue ]
    |                                      |
    | .on("progress"), .on("complete")       | .add(task), .start()
    |                                      |
    V                                      V
[ DownloadJob ]                            [ DownloadTask ]
    |                                      |
    | .on("progress"), .on("complete")       | .start()
    |                                      V
    `--(Owns)--> [ DownloadTask ]  <-----> [ storage.ts (IndexedDB) ]
    |
    `--(Owns)--> [ DownloadTask ]
    |
    `--(Owns)--> [ DownloadTask ]
```

------

### 💡 Key Design Patterns

- **Separation of Concerns:** The `Manager` doesn't know *how* to download (the `Task` does). The `Task` doesn't know *when* to download (the `Queue` does). The `Job` doesn't know how to do anything but *listen* and *aggregate*.
- **Event-Driven:** Components are loosely coupled. The `DownloadTask` doesn't know the `DownloadJob` exists; it just emits events. This makes the system easy to test and modify.
- **Resilience:** The state is not held in memory. It's stored in `IndexedDB`. This, combined with the `HEAD` request and custom `errors.ts`, makes the downloader robust against network failures, page refreshes, and server-side quirks.



## 🚀 Architectural Flow (Step-by-Step)

This is how the components interact from a user click to a completed download:

1. **UI (`main.ts`):** A user clicks "Start Job".
2. **`main.ts`** calls `manager.createJob(...)`.
3. **`DownloadManager`** creates a `new DownloadJob(...)`.
4. **`DownloadJob`** (in its constructor) creates all its `DownloadTask` instances, which sit in an "idle" state.
5. **`main.ts`** calls `manager.startJob(job)`.
6. **`DownloadManager`** loops through the job's tasks and adds them one-by-one to its internal **`DownloaderQueue`**.
7. **`DownloaderQueue`** (now running) calls its `run()` method. An `isProcessing` flag prevents this method from running multiple times at once. It pulls tasks from its queue, respecting the concurrency limit, and is the *only* component that calls `task.start()`.
8. **`DownloadTask`** takes over:
    - It checks `IndexedDB` for resume data.
    - If no data exists, it fires a `HEAD` request to get the file size.
    - It calculates an optimal chunk size (e.g., 10MB-100MB).
    - It starts its `downloadNextChunk()` loop.
    - This loop is wrapped in a `try/catch` to automatically retry `NetworkError`s up to `maxRetries` times.
    - Inside the loop: `createXHR` is called, which creates a `GET` request.
    - After each chunk downloads (`onload`), it saves the blob to `IndexedDB`.
    - It then waits for `CONNECTION_CLEANUP_DELAY` (50ms) before calling `downloadNextChunk()` again. This delay is another safeguard against network race conditions.
    - When all chunks are done, it assembles the final blob and emits `"complete"`.
9. **Events Flow Up:**
    - As the `DownloadTask` emits `"progress"`, the `DownloadJob` listens, recalculates the *total* job progress, and emits its *own* `"progress"` event.
    - The `main.ts` UI listens to *both* `job.on("progress")` (for the main bar) and `task.on("progress")` (for the individual file bars).
    - When the `DownloadTask` emits `"complete"`, the `DownloaderQueue` frees up a slot and starts the next task. The `DownloadJob` marks the task as complete and, when all tasks are done, emits its *own* `"complete"` event.



## 📋 Class & Method Details

### `DownloadManager`

(File: DownloadManager.ts)

The main public API for the SDK. It coordinates jobs and the queue.

- `constructor(concurrency = 2)`: Initializes the manager and creates its internal `DownloaderQueue` with the specified concurrency. It also adds a `beforeunload` listener to pause all downloads when the page is closed.
- `createJob(urls, filenames)`: Creates a new `DownloadJob` instance, stores it, and attaches event listeners to bubble up events.
- `startJob(job)`: Adds all tasks from a given job to the download queue.
- `pauseJob(job)`: Calls `.pause()` on every task in that job.
- `resumeJob(job)`: Adds any "paused" tasks from that job back into the queue to be resumed.
- `cancelJob(job)`: Calls `.cancel()` on every task in that job.
- `pauseAll()`: Pauses the entire `DownloaderQueue`, which in turn pauses all active downloads.
- `resumeAll()`: Resumes the `DownloaderQueue`.
- `attachJobEvents(job)` (private): Wires up listeners to bubble events from a `DownloadJob` (like `jobProgress`, `taskComplete`) to the manager instance.
- `attachQueueEvents()` (private): Bubbles events from the `DownloaderQueue` (like `queueStart`, `queueEmpty`) to the manager.



### `DownloaderQueue`

(File: DownloaderQueue.ts)

Manages download concurrency. It acts as a "gate" to ensure only a set number of tasks run at once.

- `constructor(concurrency = 2)`: Sets the maximum number of active downloads.
- `add(task)`: Adds a `DownloadTask` to the waiting list (`this.queue`).
- `start()`: Sets the queue state to `running` and calls `run()` to start processing.
- `pause()`: Sets the `running` flag to `false` and pauses all currently active tasks.
- `clear()`: Clears the waitlist and cancels all active downloads.
- `run()` (private): The core logic. It's a `while` loop that pulls tasks from `this.queue` and moves them to `this.active` as long as the concurrency limit isn't hit. It is the *only* class that calls `task.start()`. It uses an `isProcessing` flag to prevent this method from being called multiple times if events fire rapidly.



### `DownloadJob`(File: DownloadJob.ts)

A container for a group of DownloadTasks. Its primary role is to aggregate progress.

- `constructor(urls, filenames)`: Creates all `DownloadTask` instances for the job and sets up an internal `taskProgress` map to store the latest progress for each.
- `attachTaskEvents()` (private): The main logic.
    - It listens to `task.on("progress")` for *every* task.
    - When one fires, it updates its internal map and **recalculates the total percentage** for the *entire job* (sum of all loaded bytes / sum of all total bytes).
    - It then emits its own `progress` event with this aggregate data.
    - It also listens to `task.on("complete")` to count finished tasks and emit a job-level `complete` event when all are done.



### `DownloadTask`

(File: DownloadTask.ts)

The most complex class. It handles the logic for downloading a single file.

- `constructor(url, filename)`: Initializes the task with its file details and retry parameters.
- `start()`: The main entry point. It checks `IndexedDB` for resume data. If found, it resumes. If not, it calls `fetchMetadata()` to start a new download.
- `fetchMetadata()` (private): Performs a `HEAD` request to get `Content-Length` and `Accept-Ranges` headers, which are used to set `this.totalBytes` and `this.supportsResume`.
- `calculateChunkSize()` (private): Calculates the optimal chunk size, clamped between 10MB and 100MB, aiming for ~50 chunks total.
- `pause()`: Sets the state to `"paused"`, detaches all XHR listeners to prevent race conditions, and aborts the current `xhr`.
- `resume()`: Sets the state to `"downloading"` and calls `downloadNextChunk()` to restart the download loop.
- `cancel()`: Sets the state to `"canceled"`, aborts the `xhr`, and triggers a full cleanup of metadata and chunks from `IndexedDB`.
- `downloadNextChunk()` (private): The core loop. It's wrapped in a `try/catch` block that will catch `NetworkError`s and automatically retry the chunk download with an exponential backoff delay.
- `createXHR(startByte, endByte)` (private): The low-level worker. It creates an `XMLHttpRequest`, adds cache-busting parameters to the URL to prevent network errors, sets the `Range` header, and wires up the `onload`, `onprogress`, and `onerror` handlers.
- `tryParseTotalBytes(xhr)` (private): A helper to read the `Content-Range` header. This is the fallback for when the `HEAD` request fails.
- `assembleFile()` (private): Called when the download is complete. It fetches all `TaskChunk` blobs from `IndexedDB`, combines them into a single final `Blob`, verifies the size, emits the `"complete"` event, and cleans up the database.
- `handleError(err)` (private): Emits a formal error event.
- `changeState(newState)` (private): Updates the `this.state` property and emits a `"stateChange"` event.
- `emitProgress()` (private): Emits the `"progress"` event with formatted percentage and byte counts.



### Support Classes

- **`storage.ts`:** A singleton class that wraps the `idb` library to provide a clean, promise-based API for `IndexedDB`. It handles `TaskMetadata` (file size, name) and `TaskChunk` (binary data) storage.
- **`errors.ts`:** Defines the custom error classes (`DownloaderError`, `NetworkError`, `HttpError`, `UnsupportedServerErorr`, `AssemblyError`, `QuotaError`) so the UI can use `instanceof` to identify and handle different failure types.
- **`events.ts`:** Provides the `EventEmitter` base class with `on`, `off`, `emit`, and `clear` methods.
- **`utils.ts`:** Contains stateless helper functions: `calculatePercent`, `isOnline`, and `wait`.



## Events Emitted

### `DownloadManager`
(File: DownloadManager.ts)

This class bubbles up events from jobs and the queue, prefixing them for clarity.

- **`jobCreated`**: Fired when a new job is created.
    - **Payload**: The `DownloadJob` instance.
- **`jobStart`**: Fired when a job's first task is started (Note: this is bubbled from `DownloadJob`).
    - **Payload**: The `DownloadJob` instance.
- **`jobProgress`**: Fired when any task in a job reports progress, providing an aggregate for the whole job.
    - **Payload**: `{ job: DownloadJob, progress: JobProgress }`
- **`jobComplete`**: Fired when all tasks in a job are finished.
    - **Payload**: The `DownloadJob` instance.
- **`taskStart`**: Fired when a task within a job is started by the queue.
    - **Payload**: `{ job: DownloadJob, task: DownloadTask }`
- **`taskComplete`**: Fired when a task within a job successfully completes.
    - **Payload**: `{ job: DownloadJob, task: DownloadTask, blob: Blob }`
- **`taskError`**: Fired when a task within a job fails.
    - **Payload**: `{ job: DownloadJob, task: DownloadTask, error: Error }`
- **`queueStart`**: Fired when the main queue begins processing tasks.
- **`queuePause`**: Fired when the main queue is paused.
- **`queueEmpty`**: Fired when the queue is empty and all active downloads are finished.

------

### `DownloaderQueue`
(File: DownloaderQueue.ts)

This class emits events related to its internal state and task processing.

- **`queueAdd`**: Fired when a new task is added to the waiting list.
    - **Payload**: The `DownloadTask` that was added.
- **`start`**: Fired when the queue's `start()` method is called and it begins running.
- **`pause`**: Fired when the queue's `pause()` method is called.
- **`clear`**: Fired when the queue is cleared of all tasks.
- **`taskStart`**: Fired just before a task is started.
    - **Payload**: The `DownloadTask` that is starting.
- **`taskComplete`**: Fired when an active task reports completion.
    - **Payload**: The `DownloadTask` that completed.
- **`taskError`**: Fired when an active task reports an error.
    - **Payload**: The `DownloadTask` that failed.
- **`taskCancel`**: Fired when an active task is canceled.
    - **Payload**: The `DownloadTask` that was canceled.
- **`empty`**: Fired when the queue is empty and no tasks are active.

------

### `DownloadJob`
(File: DownloadJob.ts)

This class primarily aggregates and re-emits events from its tasks.

- **`taskStart`**: Fired when a task in this job starts.
    - **Payload**: The `DownloadTask` that started.
- **`progress`**: Fired when any task in the job reports progress, providing an aggregate for the whole job.
    - **Payload**: `JobProgress` object (`{ loaded, total, percent }`).
- **`taskProgress`**: Fired when a specific task reports progress.
    - **Payload**: `{ task: DownloadTask, progress: DownloadTaskProgress }`
- **`taskComplete`**: Fired when a specific task completes.
    - **Payload**: `{ task: DownloadTask, blob: Blob }`
- **`complete`**: Fired once all tasks in this job have completed.
- **`taskError`**: Fired when a specific task reports an error.
    - **Payload**: `{ task: DownloadTask, error: Error }`



### `DownloadTask`
(File: DownloadTask.ts)

This class emits detailed events about its own lifecycle.

- **`start`**: Fired when the task's `start()` method is called and it begins processing (either fetching metadata or downloading).
- **`pause`**: Fired when `pause()` is called.
- **`resume`**: Fired when `resume()` is called.
- **`cancel`**: Fired when `cancel()` is called.
- **`networkLost`**: Fired if the task detects the browser is offline (`isOnline()` is false).
- **`progress`**: Fired during an active download to report new bytes received.
    - **Payload**: `DownloadTaskProgress` object (`{ loaded, total, percent }`).
- **`complete`**: Fired after all chunks are downloaded and successfully assembled.
    - **Payload**: The final assembled `Blob`.
- **`error`**: Fired when any non-recoverable error occurs (e.g., `HttpError`, `AssemblyError`, or `NetworkError` after retries).
    - **Payload**: The `Error` (or subclass like `HttpError`) that occurred.
- **`stateChange`**: Fired *any time* the task's state changes (e.g., "idle" -> "fetching_metadata" -> "downloading").
    - **Payload**: The new `DownloadTaskState` string (e.g., "paused").


## Usage Example

```ts
import { DownloadManager } from "./lib/DownloadManager.js";
import { DownloadTask } from "./lib/DownloadTask.js"; // For type hints
import { DownloadJob } in "./lib/DownloadJob.js"; // For type hints
// Import error classes to provide specific feedback
import {
	NetworkError,
	HttpError,
	QuotaError,
	AssemblyError,
	UnsupportedServerErorr,
} from "./lib/errors.js";

// --- 1. Define Files to Download ---
const FILES_TO_DOWNLOAD = [
	{
		url: "http://localhost:3000/large.zip",
		filename: "large.zip",
	},
	{
		url: "http://localhost:3000/Lazy Programmers.pdf",
		filename: "Lazy Programmers.pdf",
	},
];

// --- 2. Initialize the SDK ---
// Set concurrency to 2 (only 2 files will download at a time)
const manager = new DownloadManager(2);

// --- 3. (Optional) Listen to Manager-level events ---
// These are good for global logging.
manager.on("taskError", ({ job, task, error }) => {
	console.error(`[Manager] Task Error in job ${job.tasks.length} files:`);
	console.error(`- File: ${task.filename}`);
	console.error(`- Error: ${error.name} (${error.message})`);

	// You can check the error type
	if (error instanceof HttpError && error.statusCode === 404) {
		console.error("-> This file was not found (404).");
	}
});

manager.on("taskComplete", ({ task, blob }) => {
	console.log(
		`[Manager] Task Complete: ${task.filename} (Size: ${blob.size})`,
	);
});

/**
 * Main function to demonstrate SDK usage.
 */
async function startDownload() {
	// --- 4. Create a Job ---
	const job = manager.createJob(
		FILES_TO_DOWNLOAD.map((u) => u.url),
		FILES_TO_DOWNLOAD.map((u) => u.filename),
	);

	console.log(`[Job] Created job with ${job.tasks.length} tasks.`);

	// --- 5. Listen to Job-level Events ---
	
	// Listen for overall job progress
	job.on("progress", ({ loaded, total, percent }) => {
		console.log(
			`[Job] Progress: ${percent.toFixed(2)}% (${loaded} / ${total} bytes)`,
		);
	});

	// Listen for when the entire job is complete
	job.on("complete", () => {
		console.log("[Job] ✨ Job Complete! All tasks finished.");

		// You can now inspect the final state of all tasks
		job.tasks.forEach((task) => {
			console.log(`- Final state of ${task.filename}: ${task.state}`);
		});
	});

	// --- 6. Start the Job ---
	console.log("[Manager] Starting job...");
	manager.startJob(job);

	// --- 7. (Optional) Programmatically control the job ---
	// For example, to pause the job after 5 seconds:
	/*
  setTimeout(() => {
    console.log("[Manager] Pausing job...");
    manager.pauseJob(job);
  }, 5000);

  // And resume it 5 seconds later:
  setTimeout(() => {
    console.log("[Manager] Resuming job...");
    manager.resumeJob(job);
  }, 10000);
  */
}

// --- Run the example ---
// You would call this from your application's entry point.
// For this demo, we'll just call it.
startDownload();
```