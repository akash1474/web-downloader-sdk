import { DownloadTask } from "./DownloadTask";

export class DownloaderQueue {
  private queue: DownloadTask[] = [];
  private active: DownloadTask[] = [];
  private concurrency: number;
  private running = false;
  private isProcessing = false;
  private taskCleanupMap: Map<DownloadTask, () => void> = new Map();
  private pendingRun = false; // Flag to indicate run() should be called after current run completes

  constructor(concurrency = 2) {
    this.concurrency = concurrency;
  }

  add(task: DownloadTask) {
    // Don't add tasks that are already finished or canceled
    if (
      task.state === "completed" ||
      task.state === "error" ||
      task.state === "canceled"
    ) {
      console.warn(`DownloaderQueue: Ignoring task in state "${task.state}"`);
      return;
    }

    // Don't add duplicates
    if (this.queue.includes(task) || this.active.includes(task)) {
      console.warn("DownloaderQueue: Task already in queue or active");
      return;
    }

    this.queue.push(task);

    if (this.running) {
      this.scheduleRun();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.scheduleRun();
  }

pause() {
  this.running = false;
  
  // Create a copy because 'task.pause()' triggers the 'pause' event,
  // which triggers 'onFinish', which modifies 'this.active' in place.
  const activeCopy = [...this.active];
  
  // We iterate in reverse so we unshift them back in correct order (Last In, First Out)
  for (let i = activeCopy.length - 1; i >= 0; i--) {
    const task = activeCopy[i];
    
    // 1. Pause the task (triggers event -> removes from active)
    task.pause();
    
    // 2. Put it back at the START of the queue so it resumes first
    if (!this.queue.includes(task)) {
      this.queue.unshift(task);
    }
  }
}

  clear() {
    // Store references before clearing
    const queueCopy = [...this.queue];
    const activeCopy = [...this.active];

    // Clear immediately to prevent new tasks from starting
    this.queue = [];
    this.active = [];
    this.running = false;
    this.pendingRun = false;

    // Clean up all active tasks
    activeCopy.forEach((task) => {
      this.cleanupTask(task);
      task.cancel();
    });
  }

  private scheduleRun() {
    if (this.isProcessing) {
      // Mark that we need to run again after current processing completes
      this.pendingRun = true;
      return;
    }
    this.run();
  }

  private async run() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (
        this.running &&
        this.active.length < this.concurrency &&
        this.queue.length > 0
      ) {
        const task = this.queue.shift()!;

        // Skip tasks that were canceled/completed while waiting in queue
        if (
          task.state === "canceled" ||
          task.state === "completed" ||
          task.state === "error" || 
          task.state === "paused" // Safety check
        ) {
          continue;
        }

        this.active.push(task);
        this.attachTaskListeners(task);
        task.start();
      }
    } finally {
      this.isProcessing = false;

      // Check if we need to run again (tasks were added during processing)
      if (this.pendingRun) {
        this.pendingRun = false;
        // Use setTimeout to avoid deep recursion and allow other events to process
        setTimeout(() => this.scheduleRun(), 0);
      } else if (
        this.running &&
        this.queue.length === 0 &&
        this.active.length === 0
      ) {
        // All work is done
        this.running = false;
      }
    }
  }

  private attachTaskListeners(task: DownloadTask) {
    const onFinish = () => {
      // Remove from active array
      const index = this.active.indexOf(task);
      if (index !== -1) {
        this.active.splice(index, 1);
      }
      // Clean up listeners
      this.cleanupTask(task);

      // Try to start next task
      if (this.running) {
        this.scheduleRun();
      }
    };

    // Existing handlers
    const onComplete = () => onFinish();
    const onError = () => onFinish();
    const onCancel = () => onFinish();
    const onPause = () => onFinish(); // Free up a concurrency slot.

    const cleanup = () => {
      // Removing listeners
      task.off("complete", onComplete);
      task.off("error", onError);
      task.off("cancel", onCancel);
      task.off("pause", onPause);
      this.taskCleanupMap.delete(task);
    };

    this.taskCleanupMap.set(task, cleanup);

    task.on("complete", onComplete);
    task.on("error", onError);
    task.on("cancel", onCancel);
    task.on("pause", onPause);
  }

  private cleanupTask(task: DownloadTask) {
    const cleanup = this.taskCleanupMap.get(task);
    if (cleanup) {
      cleanup();
    }
  }
}
