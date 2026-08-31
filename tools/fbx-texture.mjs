#!/usr/bin/env node
// Extract or replace the textures embedded in a binary FBX 7.0–7.4 file
// (the Content blob of its Video objects). Used to shrink the 8K diffuse
// maps the Renderpeople models ship with; see tools/shrink-textures.ps1.
//
//   node tools/fbx-texture.mjs extract <in.fbx> <out.jpg>
//   node tools/fbx-texture.mjs replace <in.fbx> <texture.jpg> <out.fbx>
//   node tools/fbx-texture.mjs roundtrip <in.fbx>        (self-test: re-serialize and compare)
//
// Binary FBX is a tree of records: [endOffset u32][numProps u32][propsLen u32]
// [nameLen u8][name][properties][children...][13 zero bytes if it had children].
// Replacing a property changes the size of every ancestor and shifts every
// record after it, so the file is parsed to a tree and written back out with
// fresh offsets. Property lists are kept as raw bytes except where edited.

import { readFileSync, writeFileSync } from 'node:fs';

const MAGIC = 'Kaydara FBX Binary  \0\x1a\0';
const HEADER_SIZE = 27;
const NULL_RECORD = 13;

function parse(buf) {
  if (buf.toString('latin1', 0, MAGIC.length) !== MAGIC) throw new Error('Not a binary FBX file');
  const version = buf.readUInt32LE(23);
  if (version >= 7500) throw new Error(`FBX ${version} uses 64-bit records; only 7.0-7.4 are supported`);
  const nodes = [];
  let offset = HEADER_SIZE;
  for (;;) {
    const node = parseNode(buf, offset);
    if (!node) {
      offset += NULL_RECORD;
      break;
    }
    nodes.push(node);
    offset = node.end;
  }
  return { version, nodes, footer: buf.subarray(offset) };
}

function parseNode(buf, offset) {
  const end = buf.readUInt32LE(offset);
  if (end === 0) return null;
  const numProps = buf.readUInt32LE(offset + 4);
  const propsLen = buf.readUInt32LE(offset + 8);
  const nameLen = buf[offset + 12];
  const name = buf.toString('latin1', offset + 13, offset + 13 + nameLen);
  let pos = offset + 13 + nameLen;
  const props = buf.subarray(pos, pos + propsLen);
  pos += propsLen;
  const children = [];
  let hasNull = false;
  while (pos < end) {
    const child = parseNode(buf, pos);
    if (!child) {
      hasNull = true;
      pos += NULL_RECORD;
      break;
    }
    children.push(child);
    pos = child.end;
  }
  if (pos !== end) throw new Error(`Malformed record "${name}" at ${offset}`);
  return { name, numProps, props, children, hasNull, end };
}

function nodeSize(node) {
  return 13 + node.name.length + node.props.length
    + node.children.reduce((sum, child) => sum + nodeSize(child), 0)
    + (node.hasNull ? NULL_RECORD : 0);
}

function writeNode(node, chunks, offset) {
  const head = Buffer.alloc(13 + node.name.length);
  head.writeUInt32LE(offset + nodeSize(node), 0);
  head.writeUInt32LE(node.numProps, 4);
  head.writeUInt32LE(node.props.length, 8);
  head[12] = node.name.length;
  head.write(node.name, 13, 'latin1');
  chunks.push(head, node.props);
  let pos = offset + head.length + node.props.length;
  for (const child of node.children) pos = writeNode(child, chunks, pos);
  if (node.hasNull) {
    chunks.push(Buffer.alloc(NULL_RECORD));
    pos += NULL_RECORD;
  }
  return pos;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
}

function serialize({ version, nodes, footer }) {
  const chunks = [Buffer.from(MAGIC, 'latin1'), u32(version)];
  let pos = HEADER_SIZE;
  for (const node of nodes) pos = writeNode(node, chunks, pos);
  chunks.push(Buffer.alloc(NULL_RECORD));
  pos += NULL_RECORD;
  // Footer (FBX SDK layout): 16-byte file id, 4 zero bytes, zero padding
  // chosen so the whole file is a multiple of 16 bytes, version, 120 zero
  // bytes, and the closing 16-byte magic. Only the ids come from the original.
  chunks.push(footer.subarray(0, 16), Buffer.alloc(4));
  pos += 20;
  const pad = (16 - (pos + 4 + 120 + 16) % 16) % 16;
  chunks.push(Buffer.alloc(pad), u32(version), Buffer.alloc(120), footer.subarray(footer.length - 16));
  return Buffer.concat(chunks);
}

/** Spans of the properties in a raw property list. */
function* properties(props) {
  let pos = 0;
  while (pos < props.length) {
    const start = pos;
    const type = String.fromCharCode(props[pos++]);
    switch (type) {
      case 'C': pos += 1; break;
      case 'Y': pos += 2; break;
      case 'I': case 'F': pos += 4; break;
      case 'D': case 'L': pos += 8; break;
      case 'S': case 'R': pos += 4 + props.readUInt32LE(pos); break;
      case 'b': case 'i': case 'l': case 'f': case 'd': pos += 12 + props.readUInt32LE(pos + 8); break;
      default: throw new Error(`Unknown property type "${type}"`);
    }
    yield { type, start, end: pos };
  }
}

function findVideos(tree) {
  const objects = tree.nodes.find((node) => node.name === 'Objects');
  return (objects?.children ?? []).filter((node) => node.name === 'Video');
}

/**
 * A Video record's embedded image lives in its child record "Content" as a
 * single raw-binary property. Returns that record and the property's span.
 */
function embeddedContent(video) {
  const node = video.children.find((child) => child.name === 'Content');
  if (!node) return null;
  for (const prop of properties(node.props)) {
    if (prop.type === 'R' && prop.end - prop.start > 5 + 64) return { node, span: prop };
  }
  return null;
}

function fileName(video) {
  for (const name of ['RelativeFilename', 'Filename']) {
    const node = video.children.find((child) => child.name === name);
    const prop = node && [...properties(node.props)].find((p) => p.type === 'S');
    if (prop) return node.props.toString('latin1', prop.start + 5, prop.end);
  }
  return '?';
}

function replaceContent(node, span, data) {
  node.props = Buffer.concat([
    node.props.subarray(0, span.start),
    Buffer.from('R', 'latin1'),
    u32(data.length),
    data,
    node.props.subarray(span.end),
  ]);
}

const [command, input, ...rest] = process.argv.slice(2);
if (!command || !input) {
  console.error('usage: fbx-texture.mjs extract <in.fbx> <out.jpg> | replace <in.fbx> <texture.jpg> <out.fbx> | roundtrip <in.fbx>');
  process.exit(2);
}
const source = readFileSync(input);
const tree = parse(source);

if (command === 'roundtrip') {
  const rebuilt = serialize(tree);
  const same = rebuilt.equals(source);
  console.log(`${input}: ${tree.nodes.length} top-level records, ${source.length} bytes, re-serialized ${same ? 'identically' : 'DIFFERENTLY'}`);
  process.exit(same ? 0 : 1);
}

const videos = findVideos(tree)
  .map((video) => ({ video, content: embeddedContent(video) }))
  .filter((entry) => entry.content);
if (videos.length === 0) throw new Error(`${input} has no embedded textures`);

if (command === 'extract') {
  const [output] = rest;
  const { node, span } = videos[0].content;
  writeFileSync(output, node.props.subarray(span.start + 5, span.end));
  for (const entry of videos) {
    console.log(`  ${fileName(entry.video)}: ${entry.content.span.end - entry.content.span.start - 5} bytes embedded`);
  }
  console.log(`  wrote ${output}${videos.length > 1 ? ` (first of ${videos.length})` : ''}`);
} else if (command === 'replace') {
  const [texture, output] = rest;
  const data = readFileSync(texture);
  for (const { content } of videos) replaceContent(content.node, content.span, data);
  const rebuilt = serialize(tree);
  writeFileSync(output, rebuilt);
  parse(rebuilt); // must still be a well-formed file
  console.log(`  ${output}: ${source.length} -> ${rebuilt.length} bytes, ${videos.length} texture(s) replaced with ${data.length}-byte ${texture}`);
} else {
  throw new Error(`Unknown command "${command}"`);
}
