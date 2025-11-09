import { EventEmitter } from "./events";
import { DownloadJob, JobProgress } from "./DownloadJob";
import { DownloaderQueue } from "./DownloaderQueue";
import { DownloadTask } from "./DownloadTask";

export class DownloadManager extends EventEmitter {
  private jobs: DownloadJob[] = [];
  private queue: DownloaderQueue;

  constructor(concurrency = 2) {
    super();
    this.queue = new DownloaderQueue(concurrency);
    this.attachQueueEvents();
  }

  createJob(urls: string[], filenames: string[]): DownloadJob {
    const job = new DownloadJob(urls, filenames);
    this.jobs.push(job);
    this.emit("jobCreated", job);
    this.attachJobEvents(job);
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

  private attachJobEvents(job: DownloadJob) {
    job.on("start", () => this.emit("jobStart", job));
    job.on("progress", (p: JobProgress) =>
      this.emit("jobProgress", { job, progress: p }),
    );
    job.on("complete", () => this.emit("jobComplete", job));

    // Bubble up task-level events, prefixed with the job
    job.on("taskStart", (task: DownloadTask) =>
      this.emit("taskStart", { job, task }),
    );
    job.on("taskComplete", (data: { task: DownloadTask; blob: Blob }) =>
      this.emit("taskComplete", { job, task: data.task, blob: data.blob }),
    );
    job.on("taskError", (data: { task: DownloadTask; error: Error }) =>
      this.emit("taskError", { job, task: data.task, error: data.error }),
    );
  }

  private attachQueueEvents() {
    // These are low-level events. We let the job events be the primary source
    // but these could be useful for debugging.
    this.queue.on("start", () => this.emit("queueStart"));
    this.queue.on("pause", () => this.emit("queuePause"));
    this.queue.on("empty", () => this.emit("queueEmpty"));
  }
}
