import { DownloadManager } from "./lib/DownloadManager.js";
import { DownloadTask } from "./lib/DownloadTask.js";
// Import the error types
import {
	NetworkError,
	HttpError,
	QuotaError,
	AssemblyError,
	UnsupportedServerError,
} from "./lib/errors.js";

/**
 * Helper function to format bytes into a readable string
 */
function formatBytes(bytes: number, decimals = 2): string {
	if (bytes === 0) return "0 Bytes";
	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

const manager = new DownloadManager();
const urls: { url: string; filename: string }[] = [
	{
		url: "http://localhost:3000/large.zip",
		filename: "large.zip",
	},
	{
		url: "http://localhost:3000/Lazy Programmers.pdf",
		filename: "Lazy Programmers.pdf",
	},
	{
		url: "http://localhost:3000/Sapphire - Ed Sheeran.mp3",
		filename: "Sapphire - Ed Sheeran.mp3",
	},
];

const startBtn = document.getElementById("start-job") as HTMLButtonElement;
const jobsDiv = document.getElementById("jobs") as HTMLDivElement;

// Keep a list of all tasks for the network listener
const allTasks: DownloadTask[] = [];
// *** NEW: Keep a map of tasks that failed due to network errors ***
const networkErrorTasks: Map<DownloadTask, NetworkError> = new Map();

startBtn.addEventListener("click", async () => {
	if (!urls.length) return alert("No URLs added!");

	const job = manager.createJob(
		urls.map((u) => u.url),
		urls.map((u) => u.filename)
	);

	// Create a wrapper for the entire job (progress bar + tasks)
	const jobWrapper = document.createElement("div");
	jobWrapper.className = "p-4 bg-gray-100 rounded-lg shadow-md space-y-4";
	jobsDiv.appendChild(jobWrapper);

	// --- Create Job-Level UI ---
	const jobTitle = document.createElement("h2");
	jobTitle.textContent = "Overall Job Progress";
	jobTitle.className = "text-xl font-semibold text-gray-800";

	const jobProgress = document.createElement("div");
	jobProgress.className = "w-full bg-gray-300 rounded h-4 overflow-hidden";
	const jobBar = document.createElement("div");
	jobBar.className = "bg-green-600 h-4 w-0 transition-all";
	jobProgress.appendChild(jobBar);

	const jobProgressText = document.createElement("p");
	jobProgressText.className = "text-sm text-gray-600 mt-1";
	jobProgressText.textContent = "0% (0 Bytes / 0 Bytes)";

	jobWrapper.append(jobTitle, jobProgress, jobProgressText);

	job.on("start", () => console.log("Job started"));

	// *** MERGED job.on('complete') listener ***
	job.on("complete", () => {
		console.log("Job complete");
		jobTitle.textContent = "Job Complete";
		jobBar.classList.remove("bg-green-600");
		jobBar.classList.add("bg-green-500");

		// --- Check status of all tasks ---
		console.log("--- Final Task Status ---");
		job.tasks.forEach((task) => {
			if (task.state === "completed") {
				console.log(`✅ ${task.filename}: ${task.state}`);
			} else {
				// This will catch 'error' or any other non-complete state
				console.log(`❌ ${task.filename}: ${task.state}`);
			}
		});
		console.log("-------------------------");
	});

	// Listen to the job's overall progress
	job.on("progress", ({ loaded, total, percent }) => {
		jobBar.style.width = `${percent}%`;
		jobProgressText.textContent = `${percent.toFixed(2)}% (${formatBytes(
			loaded
		)} / ${formatBytes(total)})`;
	});

	job.tasks.forEach((task: DownloadTask) => {
		// Add task to our global list
		allTasks.push(task);

		// --- Create Task UI ---
		const wrapper = document.createElement("div");
		wrapper.className = "p-4 bg-white rounded shadow";

		const name = document.createElement("p");
		name.textContent = `File: ${task.filename}`;
		name.className = "font-medium";

		const progress = document.createElement("div");
		progress.className = "w-full bg-gray-200 rounded h-2 mt-2 overflow-hidden";
		const bar = document.createElement("div");
		bar.className = "bg-blue-600 h-2 w-0 transition-all";
		progress.appendChild(bar);

		const statusText = document.createElement("p");
		statusText.className = "text-sm text-gray-500 mt-2";
		statusText.textContent = "State: idle";

		const progressText = document.createElement("p");
		progressText.className = "text-sm text-gray-500 mt-1";
		progressText.textContent = "0% (0 Bytes / 0 Bytes)";

		const controls = document.createElement("div");
		controls.className = "flex gap-3 mt-3";

		const toggleBtn = document.createElement("button");
		toggleBtn.textContent = "⏸ Pause";
		toggleBtn.className = "bg-yellow-500 text-white px-3 py-1 rounded";
		toggleBtn.disabled = true; // Disabled until download starts

		const cancelBtn = document.createElement("button");
		cancelBtn.textContent = "❌ Cancel";
		cancelBtn.className = "bg-red-600 text-white px-3 py-1 rounded";

		controls.appendChild(toggleBtn);
		controls.appendChild(cancelBtn);

		wrapper.append(name, progress, statusText, progressText, controls);
		// Append task UI to the job's wrapper
		jobWrapper.appendChild(wrapper);

		// --- Attach Event Listeners ---
		task.on("stateChange", (state) => {
			statusText.textContent = `State: ${state}`;

			switch (state) {
				case "downloading":
				case "fetching_metadata":
					toggleBtn.textContent = "⏸ Pause";
					toggleBtn.className = "bg-yellow-500 text-white px-3 py-1 rounded";
					toggleBtn.disabled = false;
					cancelBtn.disabled = false;
					// Clear from network error map on state change
					networkErrorTasks.delete(task);
					break;
				case "paused":
					toggleBtn.textContent = "▶ Resume";
					toggleBtn.className = "bg-green-600 text-white px-3 py-1 rounded";
					toggleBtn.disabled = false;
					break;
				case "error":
					toggleBtn.textContent = "Error";
					toggleBtn.disabled = true;
					cancelBtn.disabled = false; // Allow canceling a failed task
					statusText.classList.add("text-red-500");
					break;
				case "completed":
				case "canceled":
					toggleBtn.textContent = state === "completed" ? "Done" : "Canceled";
					toggleBtn.disabled = true;
					cancelBtn.disabled = true;
					networkErrorTasks.delete(task); // Clean up
					break;
				case "idle":
					toggleBtn.disabled = true;
					break;
			}
		});

		// Update progress bar and text
		task.on("progress", ({ loaded, total, percent }) => {
			bar.style.width = `${percent}%`;
			progressText.textContent = `${percent.toFixed(2)}% (${formatBytes(
				loaded
			)} / ${formatBytes(total)})`;
		});

		// Handle completion
		task.on("complete", (blob: Blob) => {
			bar.classList.remove("bg-blue-600");
			bar.classList.add("bg-green-600");
			progressText.textContent = `${100}% (${formatBytes(
				blob.size
			)} / ${formatBytes(blob.size)})`;
			console.log("Task complete", task.url, "Blob size:", blob.size);

			const saveLink = document.createElement("a");
			saveLink.href = URL.createObjectURL(blob);
			saveLink.download = task.filename;
			saveLink.textContent = `Save ${task.filename}`;
			saveLink.className = "text-blue-600 underline ml-4";
			controls.appendChild(saveLink);
		});

		// Handle errors
		task.on("error", (err: Error) => {
			console.error("Task error:", task.url, err);
			bar.classList.remove("bg-blue-600");
			bar.classList.add("bg-red-600"); // Make the bar red on error

			if (err instanceof NetworkError) {
				statusText.textContent = "Error: Network lost. Will retry...";
				// *** NEW: Add to retry map ***
				networkErrorTasks.set(task, err);
			} else if (err instanceof QuotaError) {
				statusText.textContent = "Error: Not enough disk space.";
			} else if (err instanceof HttpError) {
				statusText.textContent = `Error: Server failed (${err.statusCode}).`;
			} else if (err instanceof UnsupportedServerError) {
				statusText.textContent = "Error: Server does not support resume.";
			} else if (err instanceof AssemblyError) {
				statusText.textContent = "Error: Download corrupted. Please CANCEL.";
			} else {
				statusText.textContent = `Error: ${err.message}`;
			}
		});

		// --- Attach Button Click Handlers ---
		toggleBtn.addEventListener("click", () => {
			if (task.state === "downloading") {
				task.pause();
			} else if (task.state === "paused") {
				task.resume();
			}
		});

		cancelBtn.addEventListener("click", () => {
			task.cancel();
		});
	});
	job.on("complete", () => {
		console.log(job.tasks);
	});

	manager.startJob(job);
});

// Global network status listener
window.addEventListener("online", () => {
	console.log("Network connection restored!");
	// *** UPDATED: Only retry tasks that failed from a network error ***
	for (const task of networkErrorTasks.keys()) {
		if (task.state === "error") {
			console.log(`Retrying task (network): ${task.filename}`);
			task.start(); // This will clear the error state on its own
		} else {
			// Task is no longer in an error state, clean up map
			networkErrorTasks.delete(task);
		}
	}
});

window.addEventListener("offline", () => {
	console.log("Network connection lost.");
});
