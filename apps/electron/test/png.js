// Küçük, bağımlılıksız PNG çözücü: Page.captureScreenshot çıktısındaki piksellere Node tarafında bakmak için.
// Yalnızca 8 bit, taramasız (non-interlaced) RGB/RGBA/Gri (Chromium'un ürettiği kalıp).
const zlib = require("node:zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

// Dönüş: { width, height, data } (data RGBA, satır satır, 4 bayt/piksel)
function decodePng(buffer) {
	if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
	let offset = 8;
	let header = null;
	const idat = [];
	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const body = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			header = {
				width: body.readUInt32BE(0),
				height: body.readUInt32BE(4),
				bitDepth: body[8],
				colorType: body[9],
				interlace: body[12],
			};
		} else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	if (!header) throw new Error("PNG without IHDR");
	if (header.bitDepth !== 8 || header.interlace !== 0) throw new Error(`unsupported PNG ${JSON.stringify(header)}`);
	const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
	if (!channels) throw new Error(`unsupported PNG color type ${header.colorType}`);
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const { width, height } = header;
	const stride = width * channels;
	const pixels = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = y * (stride + 1) + 1;
		const out = y * stride;
		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? pixels[out + x - channels] : 0;
			const up = y > 0 ? pixels[out - stride + x] : 0;
			const upLeft = y > 0 && x >= channels ? pixels[out - stride + x - channels] : 0;
			const value = raw[line + x];
			let result;
			switch (filter) {
				case 0: result = value; break;
				case 1: result = value + left; break;
				case 2: result = value + up; break;
				case 3: result = value + ((left + up) >> 1); break;
				case 4: result = value + paeth(left, up, upLeft); break;
				default: throw new Error(`bad PNG filter ${filter}`);
			}
			pixels[out + x] = result & 255;
		}
	}
	const data = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const s = i * channels;
		let r, g, b, a = 255;
		if (channels === 1) r = g = b = pixels[s];
		else if (channels === 2) (r = g = b = pixels[s]), (a = pixels[s + 1]);
		else (r = pixels[s]), (g = pixels[s + 1]), (b = pixels[s + 2]), channels === 4 && (a = pixels[s + 3]);
		data[i * 4] = r;
		data[i * 4 + 1] = g;
		data[i * 4 + 2] = b;
		data[i * 4 + 3] = a;
	}
	return { width, height, data };
}

const luma = (image, x, y) => {
	const i = (y * image.width + x) * 4;
	return (77 * image.data[i] + 150 * image.data[i + 1] + 29 * image.data[i + 2]) >> 8;
};

// Kutu içindeki ({x,y,w,h}) en büyük ve ortalama parlaklık; bounding box (parlaklık >= min olan pikseller)
function regionStats(image, box, { minLuma = 200 } = {}) {
	let max = 0;
	let sum = 0;
	let count = 0;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, bright = 0;
	const x0 = Math.max(0, Math.floor(box.x));
	const y0 = Math.max(0, Math.floor(box.y));
	const x1 = Math.min(image.width, Math.ceil(box.x + box.w));
	const y1 = Math.min(image.height, Math.ceil(box.y + box.h));
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const l = luma(image, x, y);
			if (l > max) max = l;
			sum += l;
			count++;
			if (l >= minLuma) {
				bright++;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	return {
		max,
		mean: count ? sum / count : 0,
		bright,
		bbox: bright ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, cx: (minX + maxX + 1) / 2, cy: (minY + maxY + 1) / 2 } : null,
	};
}

// İki görüntünün (aynı boyut) kutu içindeki ortalama mutlak farkı
function regionDiff(a, b, box) {
	let sum = 0;
	let count = 0;
	const x0 = Math.max(0, Math.floor(box.x));
	const y0 = Math.max(0, Math.floor(box.y));
	const x1 = Math.min(a.width, b.width, Math.ceil(box.x + box.w));
	const y1 = Math.min(a.height, b.height, Math.ceil(box.y + box.h));
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			sum += Math.abs(luma(a, x, y) - luma(b, x, y));
			count++;
		}
	}
	return count ? sum / count : 0;
}

// Ölçütü sağlayan piksellerin ağırlık merkezi ve sınır kutusu (renkli metin gibi arka plandan ayrışan şeyler için kararlı)
function centroidWhere(image, predicate) {
	let n = 0, sx = 0, sy = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			const i = (y * image.width + x) * 4;
			if (predicate(image.data[i], image.data[i + 1], image.data[i + 2])) {
				n++; sx += x + 0.5; sy += y + 0.5;
				if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
			}
		}
	}
	return n ? { count: n, cx: sx / n, cy: sy / n, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } } : { count: 0, cx: null, cy: null, bbox: null };
}

module.exports = { decodePng, luma, regionStats, regionDiff, centroidWhere };
