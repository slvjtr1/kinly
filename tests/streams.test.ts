import { describe, expect, it } from "vitest";
import { qualityGroup, rankStreams, streamTags } from "../src/lib/streams";
import type { Addon, Stream } from "../src/lib/addons";
import { rankCapsFor } from "../src/lib/caps";
import type { SystemCaps } from "../src/lib/tauri";

const ids = (t: string) => streamTags(t).map((x) => x.id);
const addon = { transportUrl: "https://a/manifest.json", manifest: { id: "a", name: "A", version: "1", resources: ["stream"], types: ["movie"] } } as unknown as Addon;

describe("streamTags", () => {
  it("reads source, codec, HDR and audio", () => {
    expect(ids("Movie.2019.2160p.UHD.BluRay.REMUX.HDR10.HEVC.TrueHD.7.1.Atmos-GRP")).toEqual(["remux", "hevc", "hdr", "atmos", "truehd", "ch71"]);
    expect(ids("Movie 2019 1080p WEB-DL DDP5.1 H.264")).toEqual(["webdl", "avc", "ddp", "ch51"]);
    expect(ids("Show S01E01 1080p WEBRip x265 10bit")).toEqual(["webrip", "hevc"]);
    expect(ids("Movie.2160p.WEB.DV.HDR10+.DDP5.1.Atmos.H265")).toEqual(["webdl", "hevc", "dv", "hdr10p", "atmos", "ddp", "ch51"]);
    expect(ids("Movie 2019 AV1 1080p BluRay")).toEqual(["bluray", "av1"]);
  });
  it("does not invent tags", () => {
    expect(ids("Movie.2019.1080p.mkv")).toEqual([]);
    expect(ids("Torrentio\n1080p")).toEqual([]);
    expect(ids("clip.ts")).toEqual([]);
  });
});

describe("rankStreams", () => {
  const s = (name: string, url = "https://x/v.mkv"): Stream => ({ name, url });
  it("keeps every quality, 4K first, 1080p included", () => {
    const items = [s("720p"), ...Array.from({ length: 80 }, (_, i) => s(`2160p #${i}`)), s("1080p"), s("1080p HDCAM")];
    const r = rankStreams([{ addon, items }]);
    expect(r).toHaveLength(83);
    const groups = r.map((x) => qualityGroup(x.resolution));
    expect(groups.filter((g) => g === "1080")).toHaveLength(2);
    expect(groups[0]).toBe("2160");
    expect(r.at(-1)!.label).toBe("1080p HDCAM");
  });
  it("puts unplayable torrents last", () => {
    const r = rankStreams([{ addon, items: [{ name: "2160p", infoHash: "abc" }, s("720p")] }]);
    expect(r[0].playable).toBe(true);
    expect(r[1].why).toMatch(/Torrent/);
  });
});

describe("hardware-aware Best match", () => {
  const s = (name: string, url = "https://x/v.mkv"): Stream => ({ name, url });
  const allHw = { h264: true, hevc: true, hevc10: true, vp9: true, av1: true };
  const order = (items: Stream[], caps = {}) => rankStreams([{ addon, items }], caps).map((r) => r.label);

  it("ranks streams above the cap below every stream at or under it", () => {
    const items = [s("2160p WEB-DL x264"), s("1080p WEB-DL x264"), s("720p WEB-DL x264")];
    expect(order(items, { maxHeight: 1080, hwdec: allHw })).toEqual(["1080p WEB-DL x264", "720p WEB-DL x264", "2160p WEB-DL x264"]);
    const r = rankStreams([{ addon, items }], { maxHeight: 1080, hwdec: allHw });
    expect(r.find((x) => x.resolution === 2160)!.stutter).toMatch(/Above 1080p/);
    expect(r.find((x) => x.resolution === 1080)!.stutter).toBeUndefined();
  });

  it("without caps, prefers the highest resolution as before", () => {
    expect(order([s("1080p BluRay"), s("2160p WEB-DL")])[0]).toBe("2160p WEB-DL");
  });

  it("penalises high-resolution codecs this device decodes on the CPU", () => {
    const noHevc10 = { ...allHw, hevc10: false };
    const items = [s("2160p WEB-DL HEVC 10bit"), s("2160p WEB-DL x264"), s("1080p WEB-DL HEVC 10bit")];
    expect(order(items, { maxHeight: 2160, hwdec: noHevc10 })).toEqual(["2160p WEB-DL x264", "1080p WEB-DL HEVC 10bit", "2160p WEB-DL HEVC 10bit"]);
    // HDR implies 10-bit.
    const hdr = rankStreams([{ addon, items: [s("2160p BluRay HDR x265")] }], { maxHeight: 2160, hwdec: noHevc10 });
    expect(hdr[0].stutter).toMatch(/10-bit HEVC/);
    const av1 = rankStreams([{ addon, items: [s("2160p AV1 WEB-DL"), s("1440p WEB-DL x264")] }], { hwdec: { ...allHw, av1: false } });
    expect(av1[0].label).toBe("1440p WEB-DL x264");
    expect(av1[1].stutter).toMatch(/AV1/);
  });

  it("does not penalise CPU decoding at 1080p and below", () => {
    const r = rankStreams([{ addon, items: [s("1080p AV1"), s("720p x264")] }], { hwdec: { ...allHw, av1: false, hevc: false, hevc10: false } });
    expect(r[0].label).toBe("1080p AV1");
    expect(r.every((x) => !x.stutter)).toBe(true);
  });

  it("respects the hardware decoder's maximum height", () => {
    const r = rankStreams([{ addon, items: [s("2160p WEB-DL x264"), s("1080p WEB-DL x264")] }], { hwdec: allHw, maxHwHeight: 1080 });
    expect(r[0].resolution).toBe(1080);
  });

  it("within the cap: resolution, then source (Remux > BluRay > WEB-DL > WEBRip > HDTV), then addon order", () => {
    const items = [s("1080p HDTV"), s("1080p WEBRip"), s("1080p WEB-DL"), s("1080p BluRay"), s("1080p BluRay REMUX"), s("720p REMUX")];
    expect(order(items, { maxHeight: 1080, hwdec: allHw })).toEqual([
      "1080p BluRay REMUX", "1080p BluRay", "1080p WEB-DL", "1080p WEBRip", "1080p HDTV", "720p REMUX",
    ]);
  });

  it("prefers a sanely sized file over an implausibly small one of the same quality", () => {
    const tiny: Stream = { name: "2160p WEB-DL", url: "https://x/a", behaviorHints: { videoSize: 300 * 1024 ** 2 } };
    const real: Stream = { name: "2160p WEB-DL", url: "https://x/b", behaviorHints: { videoSize: 18 * 1024 ** 3 } };
    expect(rankStreams([{ addon, items: [tiny, real] }])[0].stream.url).toBe("https://x/b");
  });

  it("keeps unplayable streams last even when they fit the cap", () => {
    const r = rankStreams([{ addon, items: [{ name: "1080p", infoHash: "abc" }, s("2160p")] }], { maxHeight: 1080 });
    expect(r[0].playable).toBe(true);
    expect(r[1].stutter).toBeUndefined();
  });
});

describe("rankCapsFor", () => {
  const caps: SystemCaps = {
    gpus: [], cpuThreads: 4, ramMb: 4096, hwdec: { h264: true, hevc: true, hevc10: false, vp9: true, av1: false },
    maxHwHeight: 2160, recommendedMaxHeight: 1080, hwdecApi: "vaapi",
  };
  it("uses the device's recommended height for Auto and the user's limit otherwise", () => {
    expect(rankCapsFor(caps, "auto").maxHeight).toBe(1080);
    expect(rankCapsFor(caps, 720).maxHeight).toBe(720);
    expect(rankCapsFor(null, "auto")).toEqual({ maxHeight: null, hwdec: null });
    expect(rankCapsFor(null, 1440).maxHeight).toBe(1440);
  });
  it("treats every codec as CPU-decoded when hardware decoding is off", () => {
    expect(Object.values(rankCapsFor(caps, "auto", false).hwdec!).some(Boolean)).toBe(false);
  });
});
