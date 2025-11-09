import { EventEmitter } from "./events";
import { DownloadTask } from "./DownloadTask";
import { wait } from "./utils"; // 'wait' is no longer used, could be removed

export class DownloaderQueue extends EventEmitter {
  private queue: DownloadTask[] = [];
  private active: DownloadTask[] = [];
  private concurrency: number;
  private running = false;

  constructor(concurrency = 2) {
    super();
    this.concurrency = concurrency;
  }

  add(task: DownloadTask) {
    this.queue.push(task);
    this.emit("queueAdd", task);
    if (this.running) {
      this.run();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.emit("start");
    this.run();
  }

  pause() {
    this.running = false;
    this.emit("pause");
    // We also pause active tasks, but tasks in the queue are just "not started"
    this.active.forEach((t) => t.pause());
  }

  clear() {
    this.queue = [];
    // Also cancel active tasks
    this.active.forEach((t) => t.cancel());
    this.active = [];
    this.running = false;
    this.emit("clear");
  }

  private async run() {
    while (
      this.running &&
      this.active.length < this.concurrency &&
      this.queue.length > 0
    ) {
      const task = this.queue.shift()!;

      // Don't start a task that was canceled while in queue
      if (task.state === "canceled") {
        continue;
      }

      this.active.push(task);
      this.emit("taskStart", task);

      // Handle task completion/error
      const onFinish = () => {
        this.active = this.active.filter((t) => t !== task);
        task.off("complete", onComplete);
        task.off("error", onError);
        task.off("cancel", onCancel);
        this.run(); // Try to run next task
      };

      const onComplete = () => {
        this.emit("taskComplete", task);
        onFinish();
      };

      const onError = () => {
        this.emit("taskError", task);
        onFinish();
      };

      const onCancel = () => {
        this.emit("taskCancel", task);
        onFinish();
      };

      task.on("complete", onComplete);
      task.on("error", onError);
      task.on("cancel", onCancel);

      task.start();
    }

    if (this.running && this.queue.length === 0 && this.active.length === 0) {
      this.running = false;
      this.emit("empty");
    }
  }
}
