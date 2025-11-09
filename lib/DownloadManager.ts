import { EventEmitter } from "./events";
import { DownloadJob } from "./DownloadJob";

export class DownloadManager extends EventEmitter {
  private jobs: DownloadJob[] = [];

  createJob(urls: string[], filenames: string[]): DownloadJob {
    const job = new DownloadJob(urls, filenames);
    this.jobs.push(job);
    this.emit("jobCreated", job);
    this.attachJobEvents(job);
    return job;
  }

  private attachJobEvents(job: DownloadJob) {
    job.on("start", () => this.emit("jobStart", job));
    job.on("progress", (p) =>
      this.emit("jobProgress", { job, percent: p.overallPercent }),
    );
    job.on("complete", () => this.emit("jobComplete", job));
    job.on("error", (e: any) => this.emit("jobError", { job, error: e }));
  }
}
