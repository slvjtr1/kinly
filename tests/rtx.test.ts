import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isRtxGpu, rtxSuperResolutionSupport, sanitizeSettings } from "../src/lib/settings";

const gpu = (vendor: string, name: string) => ({ vendor, name });

describe("RTX Video Super Resolution", () => {
  it("detects NVIDIA RTX GPUs by name", () => {
    expect(isRtxGpu(gpu("nvidia", "NVIDIA GeForce RTX 4070"))).toBe(true);
    expect(isRtxGpu(gpu("nvidia", "NVIDIA RTX A2000 8GB Laptop GPU"))).toBe(true);
    expect(isRtxGpu(gpu("nvidia", "Quadro RTX 4000"))).toBe(true);
    expect(isRtxGpu(gpu("nvidia", "NVIDIA GeForce GTX 1660 SUPER"))).toBe(false);
    expect(isRtxGpu(gpu("nvidia", "GeForce 940MX"))).toBe(false);
    expect(isRtxGpu(gpu("amd", "AMD Radeon RX 7900 XTX"))).toBe(false);
  });

  it("is shown only with an RTX GPU, and enabled only on Windows", () => {
    const rtx = { gpus: [gpu("intel", "Intel(R) UHD Graphics 770"), gpu("nvidia", "NVIDIA GeForce RTX 4060 Laptop GPU")] };
    const gtx = { gpus: [gpu("nvidia", "NVIDIA GeForce GTX 1060")] };
    expect(rtxSuperResolutionSupport(rtx, true)).toBe("available");
    expect(rtxSuperResolutionSupport(rtx, false)).toBe("unavailable");
    expect(rtxSuperResolutionSupport(gtx, true)).toBe("hidden");
    expect(rtxSuperResolutionSupport(null, true)).toBe("hidden");
  });

  it("defaults to off and survives sanitising", () => {
    expect(DEFAULT_SETTINGS.playback.rtxSuperResolution).toBe(false);
    expect(sanitizeSettings({ playback: { rtxSuperResolution: true } }).playback.rtxSuperResolution).toBe(true);
    expect(sanitizeSettings({ playback: { rtxSuperResolution: "yes" } }).playback.rtxSuperResolution).toBe(false);
  });
});
