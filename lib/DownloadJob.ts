import { EventEmitter } from "./events";
import { DownloadTask, DownloadTaskProgress } from "./DownloadTask";
import { calculatePercent } from "./utils";

export interface JobProgress {
  loaded: number;
  total: number;
  percent: number;
}

export class DownloadJob extends EventEmitter {
  tasks: DownloadTask[];
  private completed = 0;
  private errors = 0;
  private jobTotalLoaded = 0;
  private jobTotalSize = 0;
  private taskProgress: Map<DownloadTask, { loaded: number; total: number }> =
    new Map();

  constructor(urls: string[], filenames: string[]) {
    super();
    this.tasks = urls.map((u, i) => new DownloadTask(u, filenames[i]));
    this.tasks.forEach((t) =>
      this.taskProgress.set(t, { loaded: 0, total: 0 }),
    );
    this.attachTaskEvents();
  }

  private attachTaskEvents() {
    for (const task of this.tasks) {
      task.on("start", () => this.emit("taskStart", task));

      task.on("progress", (p: DownloadTaskProgress) => {
        // Get the previous progress for this task
        const oldProg = this.taskProgress.get(task)!;

        // Update the job totals using the difference
        this.jobTotalLoaded = this.jobTotalLoaded - oldProg.loaded + p.loaded;
        this.jobTotalSize = this.jobTotalSize - oldProg.total + p.total;

        // Store this task's progress
        this.taskProgress.set(task, { loaded: p.loaded, total: p.total });

        // Recalculate percent
        const percent = calculatePercent(this.jobTotalLoaded, this.jobTotalSize);

        this.emit("progress", {
          loaded: this.jobTotalLoaded,
          total: this.jobTotalSize,
          percent: percent,
        });

        // Emit task-specific progress too
        this.emit("taskProgress", { task, progress: p });
      });

      task.on("complete", (blob: Blob) => {
        this.completed++;
        this.emit("taskComplete", { task, blob }); // Pass the blob up
        this.checkJobFinished();
      });

      task.on("error", (e: Error) => {
        this.errors++;
        this.emit("taskError", { task, error: e });
        this.checkJobFinished();
      });
    }
  }

  private checkJobFinished() {
    if (this.completed + this.errors === this.tasks.length) {
      this.emit("complete");
    }
  }
}
