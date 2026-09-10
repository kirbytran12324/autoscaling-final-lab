'use strict';

const {randomUUID} = require('node:crypto');
const {
  open,
  readFile,
  rename,
  unlink,
} = require('node:fs/promises');
const {basename, dirname, join} = require('node:path');

function serializeJsonLine(value) {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new TypeError('Value cannot be serialized as JSON');
  }

  return `${serialized}\n`;
}

async function atomicWriteJson(filePath, value) {
  const serialized = serializeJsonLine(value);
  const directory = dirname(filePath);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryFile;
  let ownsTemporaryFile = false;

  try {
    temporaryFile = await open(temporaryPath, 'wx');
    ownsTemporaryFile = true;
    await temporaryFile.writeFile(serialized, 'utf8');
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;

    await rename(temporaryPath, filePath);
    ownsTemporaryFile = false;
  } catch (error) {
    if (temporaryFile !== undefined) {
      try {
        await temporaryFile.close();
      } catch {
        // Preserve the error that interrupted the durable write.
      }
    }

    if (ownsTemporaryFile) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          error.cleanupError = cleanupError;
        }
      }
    }

    throw error;
  }
}

async function appendJsonLine(filePath, value) {
  const serialized = serializeJsonLine(value);
  let file;

  try {
    file = await open(filePath, 'a');
    await file.writeFile(serialized, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
  } catch (error) {
    if (file !== undefined) {
      try {
        await file.close();
      } catch {
        // Preserve the error that interrupted the durable append.
      }
    }

    throw error;
  }
}

async function readJsonLines(filePath) {
  let contents;

  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  if (contents.length === 0) {
    return [];
  }

  if (!contents.endsWith('\n')) {
    const lineNumber = contents.split('\n').length;
    throw new Error(
      `JSON Lines record on line ${lineNumber} lacks a terminating newline`
    );
  }

  return contents.slice(0, -1).split('\n').map((line, index) => {
    const lineNumber = index + 1;

    if (line.trim() === '') {
      throw new Error(`Blank JSON Lines record on line ${lineNumber}`);
    }

    try {
      return JSON.parse(line);
    } catch (error) {
      const parseError = new SyntaxError(
        `Malformed JSON on line ${lineNumber}: ${error.message}`
      );
      parseError.cause = error;
      throw parseError;
    }
  });
}

module.exports = {
  appendJsonLine,
  atomicWriteJson,
  readJsonLines,
};
