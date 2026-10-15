// Hostile AAC m4a files for the mux worker's byte bounds, built at test time from the small
// committed fixture media/audio-priming.m4a (after the security review's generators
// make-hostile.js and make-table.js). Nothing big is committed: sizes are chosen by the test.
//
// - wholeFileSamples({ samples, padding }): every sample is the WHOLE file (offset 0, size = the
//   file's size). Many samples = the same bytes copied again and again (disk amplification);
//   with a large padding, each sample is one huge read (memory).
// - oneByteTable({ samples }): an explicit stsz table with `samples` entries of 1 byte, all in
//   one chunk: a huge sample table in the moov box.
// - squeezedSamples({ samples, sampleBytes }): contiguous, non-overlapping samples (each read
//   small, their sum within the file) whose timestamps are squeezed into 1/44100 s steps: the
//   muxer keeps a chunk's samples in memory until it spans 0.5 s, so all of them pile up
//   (after the security re-review's make-chunky.js).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = path.join(__dirname, "media", "audio-priming.m4a");
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);

function parse({ buffer, start, end }) {
	const boxes = [];
	for (let at = start, round = 0; at < end && round < 1000; round++) {
		const size = buffer.readUInt32BE(at);
		const type = buffer.toString("latin1", at + 4, at + 8);
		if (size < 8) throw new Error("hostile-media: unexpected box size");
		boxes.push(CONTAINERS.has(type) ? { type, children: parse({ buffer, start: at + 8, end: at + size }) } : { type, payload: buffer.subarray(at + 8, at + size) });
		at += size;
	}
	return boxes;
}

const u32 = (value) => {
	const bytes = Buffer.alloc(4);
	bytes.writeUInt32BE(value >>> 0);
	return bytes;
};
const fullBox = ({ type, body }) => ({ type, payload: Buffer.concat([u32(0), body]) });
const serialize = (box) => {
	const body = box.children ? Buffer.concat(box.children.map(serialize)) : box.payload;
	return Buffer.concat([u32(body.length + 8), Buffer.from(box.type, "latin1"), body]);
};

function sourceBoxes() {
	const buffer = fs.readFileSync(SOURCE);
	const top = parse({ buffer, start: 0, end: buffer.length });
	const moov = top.find((box) => box.type === "moov");
	moov.children = moov.children.filter((box) => box.type !== "udta");
	return { top, moov };
}

function replaceSampleTable({ boxes, tables }) {
	for (const box of boxes) {
		if (box.type === "stbl") {
			const stsd = box.children.find((child) => child.type === "stsd");
			box.children = [stsd, ...tables];
		} else if (box.children) replaceSampleTable({ boxes: box.children, tables });
	}
}

function setMediaDuration({ boxes, duration }) {
	for (const box of boxes) {
		// mdhd version 0: version/flags, creation, modification, timescale, duration
		if (box.type === "mdhd") box.payload.writeUInt32BE(duration >>> 0, 16);
		else if (box.children) setMediaDuration({ boxes: box.children, duration });
	}
}

/** Every one of `samples` samples covers the whole file; `padding` zero bytes make the file bigger. */
function wholeFileSamples({ samples, padding }) {
	const { top, moov } = sourceBoxes();
	const ftyp = top.find((box) => box.type === "ftyp");
	const mdat = top.find((box) => box.type === "mdat");
	const tables = (sampleSize) => [
		fullBox({ type: "stts", body: Buffer.concat([u32(1), u32(samples), u32(1024)]) }),
		fullBox({ type: "stsc", body: Buffer.concat([u32(1), u32(1), u32(1), u32(1)]) }),
		fullBox({ type: "stsz", body: Buffer.concat([u32(sampleSize), u32(samples)]) }),
		fullBox({ type: "stco", body: Buffer.concat([u32(samples), Buffer.alloc(4 * samples)]) }),
	];
	setMediaDuration({ boxes: moov.children, duration: samples * 1024 });
	replaceSampleTable({ boxes: moov.children, tables: tables(0) });
	const total = serialize(ftyp).length + serialize(moov).length + serialize(mdat).length + 8 + padding;
	replaceSampleTable({ boxes: moov.children, tables: tables(total) });
	const file = Buffer.concat([serialize(ftyp), serialize(moov), serialize(mdat), u32(8 + padding), Buffer.from("free", "latin1"), Buffer.alloc(padding)]);
	if (file.length !== total) throw new Error("hostile-media: size mismatch");
	return file;
}

/** An explicit stsz table of `samples` one-byte entries, all in one chunk at offset 0. */
function oneByteTable({ samples }) {
	const { top, moov } = sourceBoxes();
	const table = Buffer.alloc(4 * samples);
	for (let i = 0; i < samples; i++) table.writeUInt32BE(1, 4 * i);
	replaceSampleTable({
		boxes: moov.children,
		tables: [
			fullBox({ type: "stts", body: Buffer.concat([u32(1), u32(samples), u32(1)]) }),
			fullBox({ type: "stsc", body: Buffer.concat([u32(1), u32(1), u32(samples), u32(1)]) }),
			fullBox({ type: "stsz", body: Buffer.concat([u32(0), u32(samples), table]) }),
			fullBox({ type: "stco", body: Buffer.concat([u32(1), u32(0)]) }),
		],
	});
	return Buffer.concat(top.map(serialize));
}

/** `samples` contiguous samples of `sampleBytes` bytes each, 1 tick (1/44100 s) apart. */
function squeezedSamples({ samples, sampleBytes }) {
	const { top, moov } = sourceBoxes();
	const ftyp = top.find((box) => box.type === "ftyp");
	const mdat = top.find((box) => box.type === "mdat");
	const tables = (offset) => [
		fullBox({ type: "stts", body: Buffer.concat([u32(1), u32(samples), u32(1)]) }),
		fullBox({ type: "stsc", body: Buffer.concat([u32(1), u32(1), u32(samples), u32(1)]) }),
		fullBox({ type: "stsz", body: Buffer.concat([u32(sampleBytes), u32(samples)]) }),
		fullBox({ type: "stco", body: Buffer.concat([u32(1), u32(offset)]) }),
	];
	replaceSampleTable({ boxes: moov.children, tables: tables(0) });
	const head = serialize(ftyp).length + serialize(moov).length + serialize(mdat).length;
	replaceSampleTable({ boxes: moov.children, tables: tables(head + 8) });
	return Buffer.concat([serialize(ftyp), serialize(moov), serialize(mdat), u32(8 + samples * sampleBytes), Buffer.from("free", "latin1"), Buffer.alloc(samples * sampleBytes)]);
}

module.exports = { oneByteTable, squeezedSamples, wholeFileSamples };
