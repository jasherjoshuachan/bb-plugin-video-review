Review a rendered video frame by frame beside the chat, pin notes to an exact
frame of an exact file, and hand them to an agent in one message.

## What you get

- A **Video Review** tab for .mp4, .m4v, .mov and .webm files ("Open with").
- A frame counter you can trust: the shown frame comes from the browser's
  presented-frame time mapped through the file's own timestamps, so 29.97 fps,
  variable-rate and start-offset files stay exact.
- Notes on a frame, an in–out range, or the whole video, with a category and
  boxes or arrows drawn on the picture in the video's own pixels.
- One message to this chat or a new one: the file's sha256 and version, each
  note's version-stamped frame label (`v2 00:00:36:22 (922)`), and the frame
  attached as a PNG (marked up, plus a crop).
- Live status on every note: with the agent, fixed (with the new file's
  sha256), agent asks, verified. Only you verify.
- Every render kept as a version (v1, v2, …): older renders stay viewable as
  copy-on-write clones until no open note needs them.
- Notes follow the video across renders: a note from v1 shows where its moment
  lands on v2, matched by the render manifest when there is one and by the
  pictures themselves otherwise, with how sure the match is.
- Compare two versions on the matching frame: A/B flip, side by side, wipe and
  difference, plus an exact pixel compare that boxes what changed.
- "What changed": every timing shift, changed picture and moved scene edge
  between two renders, each a jump.
- Check fixes one by one: the fixed render at the right frame, A/B against the
  original, Verify or Reopen.

## How it works

The bb server reads the video with ffprobe and ffmpeg on its own machine
(Homebrew's by default; set the paths in the plugin settings). Notes and stills
stay in the plugin's own storage; nothing leaves the machine.

## For agents

The bundled skill tells an agent to check the file's sha256, see each note's
frame with `bb video-review frame <id>`, fix and re-render, check the frame on
the new file, and close the note with
`bb video-review resolve <id> --sha <new sha256> --note "…"`. Agents can also
compare a note's frame with the new render (`bb video-review compare <id>`),
list what changed between two renders, attach a render manifest
(`bb video-review timeline`), and open the review for you at the first fixed
note (`bb video-review open <video> --frame n --compare v1`).
