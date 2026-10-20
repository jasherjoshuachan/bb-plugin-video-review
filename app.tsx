// bb-plugin-video-review — frontend entry.
//
// Videos open in a panel tab beside the chat ("Open with" → Video Review),
// where they can be stepped frame by frame and noted (see ui/opener.tsx).
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { VideoReviewOpener } from "./ui/opener";

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "video-review",
    title: "Video Review (frame notes)",
    // .vreview: an open request written by `bb video-review open` (which video, frame, compare).
    extensions: ["mp4", "m4v", "mov", "webm", "vreview"],
    component: VideoReviewOpener,
  });
});
