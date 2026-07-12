import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface LocalAuth {
  token: string | null;
  tokenFile: string;
  created: boolean;
}

export async function loadLocalAuth(tokenFile: string, noAuth: boolean): Promise<LocalAuth> {
  if (noAuth) {
    return { token: null, tokenFile, created: false };
  }

  const fromEnvironment = process.env.CODEX_TRANSLATOR_TOKEN?.trim();
  if (fromEnvironment) {
    return { token: fromEnvironment, tokenFile, created: false };
  }

  await mkdir(path.dirname(tokenFile), { recursive: true });
  try {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (token.length < 32) {
      throw new Error('Local token file is invalid: ' + tokenFile);
    }
    return { token, tokenFile, created: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  const token = randomBytes(32).toString('hex');
  try {
    const handle = await open(tokenFile, 'wx', 0o600);
    await handle.writeFile(token + '\n', 'utf8');
    await handle.close();
    return { token, tokenFile, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const existing = (await readFile(tokenFile, 'utf8')).trim();
    return { token: existing, tokenFile, created: false };
  }
}

export function tokenMatches(expected: string | null, authorization: string | undefined): boolean {
  if (expected === null) {
    return true;
  }
  const prefix = 'Bearer ';
  if (!authorization?.startsWith(prefix)) {
    return false;
  }
  const actual = authorization.slice(prefix.length);
  const expectedDigest = createHash('sha256').update(expected).digest();
  const actualDigest = createHash('sha256').update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}
