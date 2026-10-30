// Release channel shown in the app. Package versions stay plain semver (MSI needs numeric
// versions); the channel says whether this is a beta. scripts/release-meta.sh reads the next line.
export const RELEASE_CHANNEL: "beta" | "stable" = "beta";
const LABELS: Record<"beta" | "stable", string> = { beta: "Beta", stable: "" };
export const CHANNEL_LABEL = LABELS[RELEASE_CHANNEL];
