import { mkdir, readFile, appendFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

interface CacheRecord {
  key: string;
  value: string;
  createdAt: string;
}

export class TranslationCache {
  private readonly values = new Map<string, string>();
  private diskEntries = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxEntries: number,
    private readonly persistent = true,
  ) {}

  async initialize(): Promise<void> {
    if (!this.persistent) {
      return;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let contents = '';
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      return;
    }

    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as CacheRecord;
        if (typeof record.key === 'string' && typeof record.value === 'string') {
          this.values.delete(record.key);
          this.values.set(record.key, record.value);
          this.diskEntries += 1;
        }
      } catch {
        // Ignore a truncated final line after an interrupted append.
      }
    }
    this.trim();
  }

  get(key: string): string | undefined {
    const value = this.values.get(key);
    if (value !== undefined) {
      this.values.delete(key);
      this.values.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): Promise<void> {
    this.values.delete(key);
    this.values.set(key, value);
    this.trim();

    if (!this.persistent) {
      return Promise.resolve();
    }

    const record: CacheRecord = { key, value, createdAt: new Date().toISOString() };
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      await appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf8');
      this.diskEntries += 1;
      if (this.diskEntries >= this.maxEntries * 2) {
        await this.compact();
      }
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  get size(): number {
    return this.values.size;
  }

  private trim(): void {
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) {
        return;
      }
      this.values.delete(oldest);
    }
  }

  private async compact(): Promise<void> {
    const tempPath = this.filePath + '.tmp';
    const now = new Date().toISOString();
    const contents = Array.from(this.values, ([key, value]) =>
      JSON.stringify({ key, value, createdAt: now }),
    ).join('\n') + '\n';
    await writeFile(tempPath, contents, 'utf8');
    await rm(this.filePath, { force: true });
    await rename(tempPath, this.filePath);
    this.diskEntries = this.values.size;
  }
}
