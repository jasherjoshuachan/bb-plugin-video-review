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
    extensions: ["mp4", "m4v", "mov", "webm"],
    component: VideoReviewOpener,
  });
});
