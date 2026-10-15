// features.js için test varlıkları: hepsi geçici klasörde üretilir (ffmpeg ile kodlanır), depoya hiçbir şey yazılmaz.
//   click.wav       30 sn, 120 BPM kick tıkı (0,25 sn'den başlar: 60 vuruş), mono 44,1 kHz
//   silent.wav      10 sn sessizlik
//   noise.wav       20 sn beyaz gürültü
//   track.mp4       6 sn, 30 fps, 640x360, dokulu arka plan + soldan sağa 3 px/kare giden 48x48 dokulu yama, sesi click.wav
//   track.json      yamanın her karedeki gerçek merkezi (kaynak pikseli, sürekli koordinat)
//   RobotoCondensed-LightItalic.ttf, fake.ttf (yeniden adlandırılmış metin), trunc.ttf (ilk 300 bayt)
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const FFMPEG = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";
const FONT_SOURCE = "/usr/share/fonts/TTF/RobotoCondensed-LightItalic.ttf";

const VIDEO = { width: 640, height: 360, fps: 30, seconds: 6, patch: 48, speedPxPerFrame: 3, startCx: 60, cy: 180 };
const BEAT_FIRST_SEC = 0.25;
const BPM = 120;

function run(command, args, input) {
	const result = cp.spawnSync(command, args, { input, maxBuffer: 1 << 30 });
	if (result.status !== 0) {
		throw new Error(`${path.basename(command)} ${args.join(" ").slice(0, 200)} failed: ${result.stderr?.toString().slice(-600)}`);
	}
	return result;
}
const ffmpeg = (args, input) => run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args], input);

function makeRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

// 120 BPM kick: 50-160 Hz süpürme + kısa gürültü patlaması + hafif bas ve zemin gürültüsü
function clickTrackPcm({ seconds = 30, bpm = BPM, sampleRate = 44100, firstSec = BEAT_FIRST_SEC } = {}) {
	const period = 60 / bpm;
	const samples = new Int16Array(seconds * sampleRate);
	const rand = makeRandom(7);
	for (let i = 0; i < samples.length; i++) {
		const t = i / sampleRate;
		let v = 0.04 * Math.sin(2 * Math.PI * 55 * t) + 0.02 * (rand() * 2 - 1);
		const since = (((t - firstSec) % period) + period) % period;
		if (t >= firstSec) {
			const sweep = 50 * since + 110 * 0.02 * (1 - Math.exp(-since / 0.02));
			v += 0.9 * Math.exp(-since / 0.045) * Math.sin(2 * Math.PI * sweep);
			if (since < 0.003) v += 0.6 * (rand() * 2 - 1);
		}
		samples[i] = Math.max(-1, Math.min(1, v)) * 32767;
	}
	return Buffer.from(samples.buffer);
}

function beatTruthSeconds({ seconds = 30, bpm = BPM, firstSec = BEAT_FIRST_SEC } = {}) {
	const beats = [];
	for (let t = firstSec; t < seconds; t += 60 / bpm) beats.push(Number(t.toFixed(4)));
	return beats;
}

// Yumuşak dokulu gri alan (çok ölçekli değer gürültüsü), değerler [lo, hi] aralığında
function smoothNoise({ width, height, cell, rand, lo, hi }) {
	const gw = Math.ceil(width / cell) + 2;
	const gh = Math.ceil(height / cell) + 2;
	const grid = Float32Array.from({ length: gw * gh }, () => rand());
	const out = new Float32Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const gx = x / cell, gy = y / cell;
			const x0 = Math.floor(gx), y0 = Math.floor(gy);
			const fx = gx - x0, fy = gy - y0;
			const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
			const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1], c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
			out[y * width + x] = lo + (hi - lo) * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
		}
	}
	return out;
}

// Ham RGB kareler üretip ffmpeg'e borulayarak h264 mp4 yazar; sesi click.wav'dan alır.
function makeTrackingVideo({ dir, audioPath, name = "track.mp4", jsonName = "track.json", wobble = 0 }) {
	const { width, height, fps, seconds, patch, speedPxPerFrame, startCx, cy } = VIDEO;
	const frames = fps * seconds;
	const rand = makeRandom(99);
	const coarse = smoothNoise({ width, height, cell: 24, rand, lo: 50, hi: 150 });
	const fine = smoothNoise({ width, height, cell: 5, rand, lo: -30, hi: 30 });
	const background = new Uint8Array(width * height);
	for (let i = 0; i < background.length; i++) background[i] = Math.max(20, Math.min(215, coarse[i] + fine[i]));
	// Düz bölgeler: izleme "Area too flat" testi için (yama buralardan geçmez: yama y=156..204)
	const flat = [
		{ x: 20, y: 270, w: 120, h: 80 },
		{ x: 500, y: 270, w: 120, h: 80 },
	];
	for (const box of flat) {
		for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) background[y * width + x] = 110;
	}
	// Yama dokusu: arka plandan farklı, daha sık ve yüksek karşıtlıklı, tavan 235 (beyaz metin 255 ile karışmasın)
	const patchRand = makeRandom(1234);
	const patchA = smoothNoise({ width: patch, height: patch, cell: 3, rand: patchRand, lo: 25, hi: 235 });
	const patchB = smoothNoise({ width: patch, height: patch, cell: 7, rand: patchRand, lo: -20, hi: 20 });
	const patchGray = new Uint8Array(patch * patch);
	for (let i = 0; i < patchGray.length; i++) patchGray[i] = Math.max(25, Math.min(235, patchA[i] + patchB[i]));

	const truth = [];
	const frame = Buffer.alloc(width * height * 3);
	const chunks = [];
	for (let i = 0; i < frames; i++) {
		for (let p = 0; p < background.length; p++) {
			const g = background[p];
			frame[p * 3] = g;
			frame[p * 3 + 1] = Math.min(255, g + 6);
			frame[p * 3 + 2] = Math.max(0, g - 8);
		}
		const cx = startCx + speedPxPerFrame * i;
		// wobble > 0: dikeyde 1,5 periyotluk sinüs (tam sayı piksel): eğri bir yol, anahtar karesi sayısı anlamlı olsun
		const cyNow = wobble ? cy + Math.round(wobble * Math.sin((2 * Math.PI * 1.5 * i) / frames)) : cy;
		const px0 = cx - patch / 2;
		const py0 = cyNow - patch / 2;
		for (let y = 0; y < patch; y++) {
			for (let x = 0; x < patch; x++) {
				const g = patchGray[y * patch + x];
				const o = ((py0 + y) * width + px0 + x) * 3;
				frame[o] = g;
				frame[o + 1] = Math.min(255, g + 6);
				frame[o + 2] = Math.max(0, g - 8);
			}
		}
		truth.push({ frame: i, t: i / fps, cx, cy: cyNow });
		chunks.push(Buffer.from(frame));
	}
	const joined = Buffer.concat(chunks);
	const result = cp.spawnSync(
		FFMPEG,
		[
			"-y", "-hide_banner", "-loglevel", "error",
			"-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0",
			"-i", audioPath,
			"-map", "0:v", "-map", "1:a", "-t", String(seconds),
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15",
			"-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart",
			path.join(dir, name),
		],
		{ input: joined, maxBuffer: 1 << 30 },
	);
	if (result.status !== 0) throw new Error(`track.mp4 encode failed: ${result.stderr?.toString().slice(-600)}`);
	fs.writeFileSync(path.join(dir, jsonName), JSON.stringify({ video: VIDEO, flat, truth }));
	return { frames, flat };
}

function probe(file) {
	try {
		const result = run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
		return JSON.parse(result.stdout.toString());
	} catch (error) {
		return { error: error.message };
	}
}

// Parlak (beyaz) video + aynı tık sesi: beat işaretlerinin AÇIK küçük resimlerde okunurluğunu denemek için
function makeBrightVideo({ dir, audioPath }) {
	ffmpeg(["-f", "lavfi", "-i", "color=c=white:s=640x360:r=30:d=30", "-i", audioPath, "-map", "0:v", "-map", "1:a", "-t", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", path.join(dir, "bright.mp4")]);
}

// Geçici klasörü hazırlar. Dönüş: { dir, files, beatTruth, ... }
function generateAssets({ dir, realSong }) {
	const files = {
		click: path.join(dir, "click.wav"),
		silent: path.join(dir, "silent.wav"),
		noise: path.join(dir, "noise-1.wav"),
		noiseSeeds: [2, 3, 4, 5, 6].map((seed) => path.join(dir, `noise-${seed}.wav`)),
		// 10 TOHUMSUZ (her koşuda farklı rastgele) beyaz gürültü: yanlış pozitif oranı için
		noiseRandom: Array.from({ length: 10 }, (_, i) => path.join(dir, `noise-rand-${i + 1}.wav`)),
		longName: path.join(dir, "a-very-long-file-name-for-testing.wav"),
		songExcerpts: [],
		video: path.join(dir, "track.mp4"),
		font: path.join(dir, "RobotoCondensed-LightItalic.ttf"),
		fakeFont: path.join(dir, "fake.ttf"),
		truncatedFont: path.join(dir, "trunc.ttf"),
		videoBright: path.join(dir, "bright.mp4"),
	};
	ffmpeg(["-f", "s16le", "-ar", "44100", "-ac", "1", "-i", "pipe:0", "-c:a", "pcm_s16le", files.click], clickTrackPcm());
	ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "10", "-c:a", "pcm_s16le", files.silent]);
	// Beyaz gürültü, SABİT tohumla (koşular arası aynı): seed 1 ana dosya, 2-6 yanlış pozitif oranı için
	for (const [seed, file] of [[1, files.noise], ...[2, 3, 4, 5, 6].map((seed, i) => [seed, files.noiseSeeds[i]])]) {
		ffmpeg(["-f", "lavfi", "-i", `anoisesrc=d=20:c=white:r=44100:a=0.3:seed=${seed}`, "-ac", "1", "-c:a", "pcm_s16le", file]);
	}
	const video = makeTrackingVideo({ dir, audioPath: files.click });
	for (const file of files.noiseRandom) {
		ffmpeg(["-f", "lavfi", "-i", "anoisesrc=d=20:c=white:r=44100:a=0.3:seed=-1", "-ac", "1", "-c:a", "pcm_s16le", file]);
	}
	fs.copyFileSync(files.click, files.longName);
	// Gerçek şarkıdan 8 sn'lik parçalar: YALNIZ geçici klasöre yazılır (kaynak mp3 salt okunur)
	if (realSong && fs.existsSync(realSong)) {
		for (const offset of [60, 30, 120]) {
			const file = path.join(dir, `song-8s-at-${offset}.wav`);
			ffmpeg(["-ss", String(offset), "-t", "8", "-i", realSong, "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", file]);
			files.songExcerpts.push({ offset, file });
		}
	}
	makeBrightVideo({ dir, audioPath: files.click });
	fs.copyFileSync(FONT_SOURCE, files.font);
	fs.writeFileSync(files.fakeFont, "This is plain text renamed to .ttf, not a font.\n".repeat(40));
	fs.writeFileSync(files.truncatedFont, fs.readFileSync(FONT_SOURCE).subarray(0, 300));
	return {
		dir,
		files,
		video,
		videoInfo: probe(files.video).streams?.map((stream) => `${stream.codec_type}:${stream.codec_name}:${stream.width ?? ""}x${stream.height ?? ""}`),
		beatTruth: beatTruthSeconds(),
		truth: JSON.parse(fs.readFileSync(path.join(dir, "track.json"), "utf8")),
	};
}

module.exports = { generateAssets, beatTruthSeconds, VIDEO, BPM, BEAT_FIRST_SEC };
