import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_HEADER = 0x06054b50;

export function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.readUInt32LE(0) === LOCAL_HEADER;
}

export function extractFirstCsvFromZip(buffer) {
  const entries = readCentralDirectory(buffer);
  const csvEntry = entries.find((entry) => entry.fileName.toLowerCase().endsWith('.csv'));
  if (csvEntry) return extractZipEntry(buffer, csvEntry);

  return extractFirstCsvFromLocalHeaders(buffer);
}

function readCentralDirectory(buffer) {
  const eocdOffset = findEocdOffset(buffer);
  if (eocdOffset < 0) return [];

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let pos = cdOffset;
  const end = cdOffset + cdSize;

  while (pos + 46 <= buffer.length && pos < end && entries.length < totalEntries) {
    if (buffer.readUInt32LE(pos) !== CENTRAL_HEADER) break;

    const fileNameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const fileName = buffer.subarray(pos + 46, pos + 46 + fileNameLength).toString('utf8');

    entries.push({
      fileName,
      compressionMethod: buffer.readUInt16LE(pos + 10),
      compressedSize: buffer.readUInt32LE(pos + 20),
      uncompressedSize: buffer.readUInt32LE(pos + 24),
      localHeaderOffset: buffer.readUInt32LE(pos + 42)
    });

    pos += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEocdOffset(buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_HEADER) return offset;
  }
  return -1;
}

function extractZipEntry(buffer, entry) {
  const { localHeaderOffset, fileName, compressionMethod } = entry;
  if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER) {
    throw new Error('ZIP-ul contine o intrare invalida.');
  }

  const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;

  let compressedSize = entry.compressedSize || buffer.readUInt32LE(localHeaderOffset + 18);
  let uncompressedSize = entry.uncompressedSize || buffer.readUInt32LE(localHeaderOffset + 22);

  const flags = buffer.readUInt16LE(localHeaderOffset + 6);
  if (!compressedSize && (flags & 0x08)) {
    const descriptor = findDataDescriptor(buffer, dataStart);
    compressedSize = descriptor.compressedSize;
    uncompressedSize = descriptor.uncompressedSize;
  }

  if (!compressedSize) throw new Error(`ZIP-ul nu poate determina marimea fisierului ${fileName}.`);

  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  return { fileName, buffer: decompressEntry(compressed, compressionMethod, uncompressedSize) };
}

function findDataDescriptor(buffer, dataStart) {
  const maxScan = Math.min(buffer.length - dataStart, 1024 * 1024 * 4);
  for (let size = 0; size < maxScan; size += 1) {
    const offset = dataStart + size;
    if (buffer.readUInt32LE(offset) !== 0x08074b50) continue;
    return {
      compressedSize: buffer.readUInt32LE(offset + 4),
      uncompressedSize: buffer.readUInt32LE(offset + 8)
    };
  }
  throw new Error('ZIP-ul nu contine descriptorul de date asteptat.');
}

function decompressEntry(compressed, compressionMethod, uncompressedSize) {
  if (compressionMethod === 0) return compressed;
  if (compressionMethod === 8) {
    const inflated = inflateRawSync(compressed);
    if (uncompressedSize && inflated.length !== uncompressedSize) {
      throw new Error('CSV-ul din ZIP pare corupt.');
    }
    return inflated;
  }
  throw new Error(`Metoda ZIP ${compressionMethod} nu este suportata.`);
}

function extractFirstCsvFromLocalHeaders(buffer) {
  let offset = 0;
  while (offset + 30 < buffer.length) {
    if (buffer.readUInt32LE(offset) !== LOCAL_HEADER) break;

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const fileNameStart = offset + 30;
    const fileName = buffer.subarray(fileNameStart, fileNameStart + fileNameLength).toString('utf8');
    const dataStart = fileNameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const compressed = buffer.subarray(dataStart, dataEnd);

    if (fileName.toLowerCase().endsWith('.csv')) {
      return { fileName, buffer: decompressEntry(compressed, compressionMethod, uncompressedSize) };
    }

    offset = compressedSize ? dataEnd : offset + 30 + fileNameLength + extraLength;
  }

  throw new Error('ZIP-ul nu contine niciun fisier CSV.');
}

/** Test helper: Intune-style ZIP with sizes only in central directory. */
export function createIntuneStyleZip(fileName, content) {
  const name = Buffer.from(fileName);
  const plain = Buffer.from(content);
  const compressed = deflateRawSync(plain);
  const flags = 0x0008;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_HEADER, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 18);
  local.writeUInt32LE(0, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const fileData = Buffer.concat([local, name, compressed]);
  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(CENTRAL_HEADER, 0);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(compressed.length, 20);
  cd.writeUInt32LE(plain.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt32LE(0, 42);
  name.copy(cd, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_HEADER, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(fileData.length, 16);

  return Buffer.concat([fileData, cd, eocd]);
}
