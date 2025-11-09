import { EventEmitter } from "./events";
import { DownloadTask } from "./DownloadTask";
import { wait } from "./utils";

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
    if (this.running) this.run();
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
    this.active.forEach((t) => t.pause());
  }

  clear() {
    this.queue = [];
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
      this.active.push(task);
      this.emit("taskStart", task);
      task.start();

      const onComplete = () => {
        this.active = this.active.filter((t) => t !== task);
        this.emit("taskComplete", task);
        task.off("complete", onComplete);
        this.run();
      };

      task.on("complete", onComplete);
      task.on("error", () => {
        this.active = this.active.filter((t) => t !== task);
        this.emit("taskError", task);
        this.run();
      });

      await wait(50); // small delay to avoid race
    }

    if (this.queue.length === 0 && this.active.length === 0) {
      this.running = false;
      this.emit("empty");
    }
  }
}
