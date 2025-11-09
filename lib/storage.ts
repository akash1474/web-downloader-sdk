import { IDBPDatabase, openDB } from "idb"; // You'll need to import 'idb'

/* NOTE: This implementation now uses the 'idb' library by Jake Archibald.
  It's a tiny wrapper that makes IndexedDB much easier to use with promises.

  You can get it via NPM: `npm install idb`
  Or use it from a CDN in your HTML:
  <script src="https://cdn.jsdelivr.net/npm/idb@7/build/umd.js"></script>
*/

const DB_NAME = "downloaderDB";
const METADATA_STORE = "taskMetadata";
const CHUNK_STORE = "taskChunks";

export interface TaskMetadata {
  url: string;
  filename: string;
  totalBytes: number;
  downloadedBytes: number;
  supportsResume: boolean;
}

export interface TaskChunk {
  url: string;
  index: number;
  blob: Blob;
}

class DownloaderDB {
  private dbPromise: Promise<IDBPDatabase>;

  constructor() {
    this.dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(METADATA_STORE)) {
          db.createObjectStore(METADATA_STORE, { keyPath: "url" });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const store = db.createObjectStore(CHUNK_STORE, {
            autoIncrement: true,
          });
          store.createIndex("url_index", ["url", "index"], { unique: true });
        }
      },
    });
  }

  // --- Metadata Methods ---

  async getMetadata(url: string): Promise<TaskMetadata | undefined> {
    return (await this.dbPromise).get(METADATA_STORE, url);
  }

  async saveMetadata(metadata: TaskMetadata): Promise<void> {
    await (await this.dbPromise).put(METADATA_STORE, metadata);
  }

  async clearMetadata(url: string): Promise<void> {
    await (await this.dbPromise).delete(METADATA_STORE, url);
  }

  // --- Chunk Methods ---

  async saveChunk(chunk: TaskChunk): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    const index = tx.store.index("url_index");

    // Check if chunk already exists
    const existing = await index.get([chunk.url, chunk.index]);
    if (!existing) {
      await tx.store.add(chunk);
    }
    await tx.done;
  }

  async getChunks(url: string): Promise<TaskChunk[]> {
    const db = await this.dbPromise;
    const chunks = await db.getAllFromIndex(
      CHUNK_STORE,
      "url_index",
      IDBKeyRange.bound([url, 0], [url, Infinity]),
    );
    // Ensure they are sorted by index
    return chunks.sort((a, b) => a.index - b.index);
  }

  async clearChunks(url: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    const index = tx.store.index("url_index");
    let cursor = await index.openCursor(
      IDBKeyRange.bound([url, 0], [url, Infinity]),
    );

    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  async clearAllData(): Promise<void> {
    const db = await this.dbPromise;
    await db.clear(METADATA_STORE);
    await db.clear(CHUNK_STORE);
  }
}

// Export a singleton instance
export const downloaderDB = new DownloaderDB();
