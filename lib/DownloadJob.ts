import { EventEmitter } from "./events";
import { DownloadTask, DownloadTaskProgress } from "./DownloadTask";

export class DownloadJob extends EventEmitter {
  tasks: DownloadTask[];
  private completed = 0;

  constructor(urls: string[], filenames: string[]) {
    super();
    this.tasks = urls.map((u, i) => new DownloadTask(u, filenames[i]));
    this.attachTaskEvents();
  }

  start() {
    this.emit("start");
    this.tasks.forEach((t) => t.start());
  }

  pause() {
    this.emit("pause");
    this.tasks.forEach((t) => t.pause());
  }

  resume() {
    this.emit("resume");
    this.tasks.forEach((t) => t.resume());
  }

  cancel() {
    this.emit("cancel");
    this.tasks.forEach((t) => t.cancel());
  }

  private attachTaskEvents() {
    for (const task of this.tasks) {
      task.on("start", () => this.emit("taskStart", task));
      task.on("progress", (p: DownloadTaskProgress) =>
        this.emit("taskProgress", { task, progress: p }),
      );
      task.on("complete", () => {
        this.completed++;
        this.emit("taskComplete", task);
        if (this.completed === this.tasks.length) this.emit("complete");
        else {
          const percent = (this.completed / this.tasks.length) * 100;
          this.emit("progress", { overallPercent: percent });
        }
      });
      task.on("error", (e: Error) =>
        this.emit("taskError", { task, error: e }),
      );
    }
  }
}
