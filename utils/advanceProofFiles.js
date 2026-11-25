import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../uploads/advance-proofs');

export async function ensureAdvanceProofDirectory() {
  await mkdir(directory, { recursive: true });
}

export async function removeAdvanceProofFile(filename) {
  if (!filename) return;
  try {
    await unlink(path.join(directory, filename));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function advanceProofPath(filename) {
  return path.join(directory, filename);
}
