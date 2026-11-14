// Purpose: Reject Windows crypto helpers that require a separately installed Visual C++ runtime.
//
// Usage:
//   npm run package:crypto          # Check the helper before packaging it on Windows
//   npm run check:native-package     # Check the helper again after assembling the release
import { readFileSync } from "node:fs";

export function assertStaticWindowsRuntime(path) {
  const image = readFileSync(path);
  const pe = image.readUInt32LE(0x3c);
  const optional = pe + 24;
  if (image.readUInt16LE(0) !== 0x5a4d || image.readUInt32LE(pe) !== 0x4550
    || image.readUInt16LE(pe + 4) !== 0x8664 || image.readUInt16LE(optional) !== 0x20b) {
    throw new Error("Expected an x64 Windows PE executable for butler-crypto.");
  }
  const sections = optional + image.readUInt16LE(pe + 20);
  const sectionCount = image.readUInt16LE(pe + 6);
  function fileOffset(rva, size) {
    for (let i = 0; i < sectionCount; i++) {
      const section = sections + 40 * i;
      const delta = rva - image.readUInt32LE(section + 12);
      if (delta >= 0 && delta + size <= image.readUInt32LE(section + 16)) {
        const offset = image.readUInt32LE(section + 20) + delta;
        if (offset + size <= image.length) return offset;
      }
    }
    throw new Error("Invalid Windows PE import address.");
  }

  // PE32+ data directories 1 and 13 hold regular and delay-loaded imports.
  const directoryCount = image.readUInt32LE(optional + 108);
  for (const { index, entrySize, nameField } of [
    { index: 1, entrySize: 20, nameField: 12 },
    { index: 13, entrySize: 32, nameField: 4 }
  ]) {
    if (index >= directoryCount) continue;
    const directory = optional + 112 + index * 8;
    const rva = image.readUInt32LE(directory);
    const size = image.readUInt32LE(directory + 4);
    if (!rva) continue;
    for (let entry = 0; entry + entrySize <= size; entry += entrySize) {
      const descriptor = fileOffset(rva + entry, entrySize);
      const nameRva = image.readUInt32LE(descriptor + nameField);
      if (!nameRva) break;
      if (index === 13 && !(image.readUInt32LE(descriptor) & 1)) throw new Error("Unsupported Windows delay-import address.");
      const name = fileOffset(nameRva, 1);
      const end = image.indexOf(0, name);
      if (end === -1) throw new Error("Unterminated Windows DLL import name.");
      const dll = image.toString("ascii", name, end);
      if (/^(?:vcruntime|msvcp).*\.dll$/i.test(dll)) {
        throw new Error(`butler-crypto imports ${dll}. Rebuild the Windows helper with a static Visual C++ runtime.`);
      }
    }
  }
}
