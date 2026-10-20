# bb-plugin-video-review

Review rendered videos frame by frame in bb and hand pinned notes to an agent.
See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what it does.

## Layout

- `server.ts`: RPCs for the tab, the still images route, the send flow, and
  the `bb video-review` CLI.
- `lib/frame-math.ts`: frame ↔ time mapping shared by server and player.
- `lib/frames.ts`: sha256, ffprobe timestamp table, ffmpeg still extraction.
- `lib/store.ts`, `lib/status.ts`: notes in SQLite and who may change a status.
- `lib/message.ts`, `lib/cli.ts`: the hand-off message and the agent's commands.
- `lib/align.ts`: frame-by-frame alignment of two renders (tiny signatures,
  coarse then banded dynamic time warping) and the change report.
- `lib/timeline.ts`: render manifests (sections and scenes) and mapping by them.
- `lib/versions.ts`: keeping older renders (APFS clones) and pruning them.
- `lib/compare.ts`: full-resolution pixel compare of two frames.
- `lib/crossversion.ts`: the above together: files per version, note mapping.
- `ui/`: the file-opener tab (player, notes, editor, compare).
- `skills/video-review/SKILL.md`: how agents handle notes.
- `spike/browser-check.ts`: headless Chrome check that the browser's frame and
  the server's still are the same frame.

## Develop

```
npm install
npm run typecheck
npm test
bb plugin build .
bb plugin install .
```

`npm test` needs ffmpeg and ffprobe on PATH.

## Credits

Adapted from Doc Review (MIT, Foma) and Inline Media (MIT). See [NOTICE](NOTICE).
