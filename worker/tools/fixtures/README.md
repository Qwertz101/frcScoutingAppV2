# SoCal OCR regression fixtures

Scoreboard-only crops from the official SoCal Showdown Fall 2026 Day 1 stream,
https://www.youtube.com/watch?v=uyGS9UNrbTY, observed October 10, 2026.
The rest of each 1920x1080 frame is black; no match video is retained.

- `socal-pregame.png`: Qualification 12, red 0, blue 0, timer 0:20.
- `socal-teleop.png`: Qualification 12 at video time 14201 seconds,
  red 147, blue 188, timer 1:41.

Ground truth was visually checked against the original frames. Tests decode
these with ffmpeg and use the actual shared Tesseract pipeline. The teleop
fixture is also tested at 1280x720.
