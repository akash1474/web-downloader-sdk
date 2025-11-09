export type EventHandler<T = any> = (payload: T) => void;

export class EventEmitter {
  private listeners: Map<string, EventHandler[]> = new Map();

  on<T = any>(event: string, handler: EventHandler<T>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);
  }

  off<T = any>(event: string, handler: EventHandler<T>): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    const index = handlers.indexOf(handler);
    if (index > -1) {
      handlers.splice(index, 1);
    }
  }

  emit<T = any>(event: string, payload?: T): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    // Use a copy in case handlers are modified during iteration
    for (const handler of [...handlers]) {
      handler(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
