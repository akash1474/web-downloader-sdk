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
        // Store this task's progress
        this.taskProgress.set(task, { loaded: p.loaded, total: p.total });

        // Recalculate total job progress
        let totalLoaded = 0;
        let totalSize = 0;
        for (const prog of this.taskProgress.values()) {
          totalLoaded += prog.loaded;
          totalSize += prog.total;
        }

        const percent = calculatePercent(totalLoaded, totalSize);
        this.emit("progress", {
          loaded: totalLoaded,
          total: totalSize,
          percent: percent,
        });

        // Emit task-specific progress too
        this.emit("taskProgress", { task, progress: p });
      });

      task.on("complete", (blob: Blob) => {
        this.completed++;
        // Pass the blob up
        this.emit("taskComplete", { task, blob });
        if (this.completed === this.tasks.length) {
          this.emit("complete");
        }
      });

      task.on("error", (e: Error) =>
        this.emit("taskError", { task, error: e }),
      );
    }
  }
}
