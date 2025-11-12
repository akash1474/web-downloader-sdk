import { DownloadJob, JobProgress } from "./DownloadJob";
import { DownloaderQueue } from "./DownloaderQueue";

export class DownloadManager {
	private jobs: DownloadJob[] = [];
	private queue: DownloaderQueue;

	constructor(concurrency = 2) {
		this.queue = new DownloaderQueue(concurrency);

		// Ensure proper cleanup on page unload
		window.addEventListener("beforeunload", () => {
			this.pauseAll();
		});
	}

	createJob(urls: string[], filenames: string[]): DownloadJob {
		const job = new DownloadJob(urls, filenames);
		this.jobs.push(job);
		return job;
	}

	startJob(job: DownloadJob) {
		job.tasks.forEach((task) => {
			// Only add if it's not already in progress or queued
			if (task.state === "idle" || task.state === "paused") {
				this.queue.add(task);
			}
		});
		this.queue.start();
	}

	pauseJob(job: DownloadJob) {
		job.tasks.forEach((task) => task.pause());
	}

	resumeJob(job: DownloadJob) {
		job.tasks.forEach((task) => {
			// Only resume a paused task
			if (task.state === "paused") {
				this.queue.add(task);
			}
		});
		this.queue.start();
	}

	cancelJob(job: DownloadJob) {
		job.tasks.forEach((task) => task.cancel());
	}

	pauseAll() {
		this.queue.pause();
	}

	resumeAll() {
		this.queue.start();
	}
}
