'use strict';

const {randomUUID} = require('node:crypto');
const {link, open, readFile, rename, unlink} = require('node:fs/promises');
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

async function atomicCreateJson(filePath, value) {
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
    await link(temporaryPath, filePath);
    await unlink(temporaryPath);
    ownsTemporaryFile = false;
  } catch (error) {
    if (temporaryFile !== undefined) {
      try {
        await temporaryFile.close();
      } catch {
        // Preserve the error that interrupted the immutable create.
      }
    }

    if (ownsTemporaryFile) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
      }
    }

    throw error;
  }
}

async function readJsonFile(filePath, description) {
  let contents;

  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    const parseError = new SyntaxError(
      `Malformed ${description}: ${error.message}`
    );
    parseError.cause = error;
    throw parseError;
  }
}

module.exports = {
  serializeJsonLine,
  atomicWriteJson,
  atomicCreateJson,
  readJsonFile,
};
