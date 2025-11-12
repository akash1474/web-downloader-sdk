import { IDBPDatabase, openDB } from "idb";

/* NOTE: This implementation uses the 'idb' library.
  It wraps the native IndexedDB API (which is event-based) into a Promise-based API,
  making async/await usage possible and significantly cleaner.
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
  chunkSize: number;
}

export interface TaskChunk {
  url: string;
  index: number;
  blob: Blob;
}

class DownloadStorage {
  private dbPromise: Promise<IDBPDatabase>;

  constructor() {
    // openDB(name, version, callbacks): Opens connection to IDB.
    this.dbPromise = openDB(DB_NAME, 1, {
      // 'upgrade' only runs if the browser has an older version or no DB at all.
      // This is where we define the schema (create 'tables' and indices).
      upgrade(db) {
        // Create the Metadata Store (like a SQL Table)
        if (!db.objectStoreNames.contains(METADATA_STORE)) {
          // keyPath: 'url' means the object's "url" property is the Primary Key.
          db.createObjectStore(METADATA_STORE, { keyPath: "url" });
        }
        // Create the Chunk Store
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const store = db.createObjectStore(CHUNK_STORE, {
            autoIncrement: true, // IDB generates a unique key automatically
          });
          // Create an Index to efficiently search chunks by "url" AND "index".
          // This allows us to query: "Get chunk 5 for specific-url.com"
          store.createIndex("url_index", ["url", "index"], { unique: true });
        }
      },
    });
  }

  // --- Metadata Methods ---

  async getMetadata(url: string): Promise<TaskMetadata | undefined> {
    // .get(store, key): Simple key-value lookup (like Map.get)
    return (await this.dbPromise).get(METADATA_STORE, url);
  }

  async saveMetadata(metadata: TaskMetadata): Promise<void> {
    // .put(store, value): Inserts or Updates (Upsert) the record.
    await (await this.dbPromise).put(METADATA_STORE, metadata);
  }

  async clearMetadata(url: string): Promise<void> {
    await (await this.dbPromise).delete(METADATA_STORE, url);
  }

  // --- Chunk Methods ---

  async saveChunk(chunk: TaskChunk): Promise<void> {
    const db = await this.dbPromise;
    // Transactions ensure data integrity. "readwrite" is required for modifications.
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    const index = tx.store.index("url_index");

    // Check via the composite index if this specific chunk already exists
    const existing = await index.get([chunk.url, chunk.index]);
    if (!existing) {
      await tx.store.add(chunk);
    }
    await tx.done; // Wait for transaction to commit
  }

  async getChunks(url: string): Promise<TaskChunk[]> {
    const db = await this.dbPromise;
    // getAllFromIndex: Fetches all records matching a query on an index.
    // IDBKeyRange.bound: Limits query to this specific URL, from index 0 to Infinity.
    const chunks = await db.getAllFromIndex(
      CHUNK_STORE,
      "url_index",
      IDBKeyRange.bound([url, 0], [url, Infinity]),
    );
    // IDB doesn't guarantee perfect return order, so we sort in memory.
    return chunks.sort((a, b) => a.index - b.index);
  }

  async clearChunks(url: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    const index = tx.store.index("url_index");

    // openCursor: Iterates over records one by one within the specified range.
    // This is more memory efficient than getting all items and deleting them.
    let cursor = await index.openCursor(
      IDBKeyRange.bound([url, 0], [url, Infinity]),
    );

    while (cursor) {
      await cursor.delete(); // Delete the record currently pointed to
      cursor = await cursor.continue(); // Move to next record
    }
    await tx.done;
  }

  async clearAllData(): Promise<void> {
    const db = await this.dbPromise;
    // .clear(): Wipes everything in the store. Truncate table equivalent.
    await db.clear(METADATA_STORE);
    await db.clear(CHUNK_STORE);
  }
}

// Export a singleton instance
export const downloadStorage = new DownloadStorage();
