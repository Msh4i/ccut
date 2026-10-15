# Media fixtures for the link-import mux tests

Small synthetic files (about 5 KB each) for `apps/electron/test/link-import-mux.test.js` and the
pair mode of `fake-yt-dlp.js`. They were generated ONCE with ffmpeg 6.1.1 and are committed: the
tests never need ffmpeg, and Ccut never ships or runs it. Re-create them only if a test needs a
new property, with exactly these commands (run in this folder):

```sh
FF="ffmpeg -nostdin -hide_banner -loglevel error -y -threads 1 -bitexact"
FRAG="-movflags frag_keyframe+empty_moov+default_base_moof"

# H.264 video-only, fragmented like a YouTube DASH stream: 128x72, 10 fps, 1 s, keyframe every 5 frames, no B-frames
$FF -f lavfi -i testsrc2=size=128x72:rate=10 -t 1 -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 5 -keyint_min 5 -sc_threshold 0 -bf 0 -crf 40 -an $FRAG video-frag.mp4
# H.264 video-only with B-frames (composition time != decode time), not fragmented, B-frame delay edit list
$FF -f lavfi -i testsrc2=size=128x72:rate=10 -t 1 -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 5 -keyint_min 5 -sc_threshold 0 -bf 2 -crf 40 -an -movflags +faststart video-bframes.mp4
# AAC-LC 44.1 kHz stereo audio-only, fragmented (0.5 s fragments) like YouTube's m4a_dash
$FF -f lavfi -i sine=frequency=440:sample_rate=44100 -t 1 -c:a aac -b:a 32k -ac 2 -frag_duration 500000 $FRAG audio-frag.m4a
# the same audio not fragmented: ffmpeg writes the AAC priming edit list (media_time 1024), so the first packet is at -0.0232 s
$FF -f lavfi -i sine=frequency=440:sample_rate=44100 -t 1 -c:a aac -b:a 32k -ac 2 -movflags +faststart audio-priming.m4a
# a wrong codec for the video side: VP9 in a fragmented MP4
$FF -f lavfi -i testsrc2=size=128x72:rate=10 -t 1 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -crf 50 -b:v 0 -an $FRAG video-vp9.mp4
```

What mediabunny 1.41.0 reads from them (packets, first timestamp): `video-frag.mp4` 10 (2 key), 0;
`video-bframes.mp4` 10 (2 key, 2 out of presentation order), 0; `audio-frag.m4a` 45, 0;
`audio-priming.m4a` 45, -0.023220 (1024 / 44100); `video-vp9.mp4` codec vp9.
