import { DownloadTask } from "./DownloadTask";
import { wait } from "./utils"; // 'wait' is no longer used, could be removed

export class DownloaderQueue{
  private queue: DownloadTask[] = [];
  private active: DownloadTask[] = [];
  private concurrency: number;
  private running = false;
  private isProcessing = false;

  constructor(concurrency = 2) {
    this.concurrency = concurrency;
  }

  add(task: DownloadTask) {
    this.queue.push(task);
    if (this.running) {
      this.run();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.run();
  }

  pause() {
    this.running = false;
    // We also pause active tasks, but tasks in the queue are just "not started"
    this.active.forEach((t) => t.pause());
  }

  clear() {
    this.queue = [];
    // Also cancel active tasks
    this.active.forEach((t) => t.cancel());
    this.active = [];
    this.running = false;
  }

  private async run() {
    if (this.isProcessing) return; // Prevent concurrent runs
    this.isProcessing = true;
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

      // Handle task completion/error
      const onFinish = () => {
        this.active = this.active.filter((t) => t !== task);
        task.off("complete", onComplete);
        task.off("error", onError);
        task.off("cancel", onCancel);
        this.run(); // Try to run next task
      };

      const onComplete = () => {
        onFinish();
      };

      const onError = () => {
        onFinish();
      };

      const onCancel = () => {
        onFinish();
      };

      task.on("complete", onComplete);
      task.on("error", onError);
      task.on("cancel", onCancel);

      task.start();
    }
    this.isProcessing = false;

    if (this.running && this.queue.length === 0 && this.active.length === 0) {
      this.running = false;
    }
  }
}
