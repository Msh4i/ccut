// The bytes the fake yt-dlp "downloads" when no sample file or URL is configured: an MP4 "ftyp"
// box (so the container check passes), then a fixed, odd-sized pattern so a test can check every
// byte that crossed the chunked transfer. Not playable; the real-window test uses real samples.
const FAKE_MEDIA_BYTES = 300_007;
const FTYP = Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom", "latin1"), 0, 0, 2, 0, ...Buffer.from("isommp41", "latin1")]);

function fakeMediaBytes(size = FAKE_MEDIA_BYTES) {
	const bytes = Buffer.alloc(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
	FTYP.copy(bytes, 0);
	return bytes;
}

module.exports = { FAKE_MEDIA_BYTES, fakeMediaBytes };
