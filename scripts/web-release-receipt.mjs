import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateWebReceipt } from "./production-release.mjs";
const receipt = {
  status: "release-web-image-pushed",
  digest: "kishikawakatsumi/applelocalization-web@" + process.env.IMAGE_DIGEST,
  commit: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  platform: "linux/amd64",
};
validateWebReceipt(receipt);
const bytes = JSON.stringify(receipt, null, 2) + "\n";
await writeFile("web-release.json", bytes, { flag: "wx" });
console.log(
  "web-release.json SHA-256: " +
    createHash("sha256").update(bytes).digest("hex"),
);
