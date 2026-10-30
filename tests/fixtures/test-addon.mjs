// Minimal Stremio stream addon for integration tests. Serves Tears of Steel
// (CC-BY 3.0, Blender Foundation) from its official download URL, plus a
// torrent-only entry and a broken URL to exercise unsupported/error states.
//   node tests/fixtures/test-addon.mjs   ->  http://127.0.0.1:7171/manifest.json
import http from "node:http";

const PORT = Number(process.env.PORT ?? 7171);
const TOS = "tt2285752";
const manifest = {
  id: "org.kinly.testaddon",
  version: "1.0.0",
  name: "Kinly Test Streams",
  description: "Open-licensed test streams for Kinly integration tests",
  resources: ["stream"],
  types: ["movie"],
  idPrefixes: ["tt"],
  catalogs: [],
};
const streams = {
  [TOS]: [
    {
      name: "Blender\n720p",
      title: "Tears of Steel 720p (official)\n💾 355 MB",
      url: "https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov",
      behaviorHints: { filename: "tears_of_steel_720p.mov", videoSize: 372178639, bingeGroup: "kinly-test" },
    },
    { name: "Torrent\n1080p", title: "Tears.of.Steel.2012.1080p.BluRay.x264", infoHash: "0000000000000000000000000000000000000000" },
    { name: "Broken\n480p", title: "Unreachable test source", url: `http://127.0.0.1:${PORT}/missing.mp4` },
    // Release-name variants for the quality filter and badges. They all play the same 720p file.
    ...[
      ["4K", "Tears.of.Steel.2012.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.7.1.Atmos-TEST", 52e9],
      ["4K", "Tears.of.Steel.2012.2160p.WEB-DL.DDP5.1.Atmos.HDR10+.H.265-TEST", 18e9],
      ["4K", "Tears.of.Steel.2012.2160p.AV1.10bit.WEBRip.Opus-TEST", 6e9],
      ["1080p", "Tears.of.Steel.2012.1080p.BluRay.x264.DTS-HD.MA.5.1-TEST", 12e9],
      ["1080p", "Tears.of.Steel.2012.1080p.WEB-DL.DDP5.1.H.264-TEST", 4e9],
      ["1080p", "Tears.of.Steel.2012.1080p.WEBRip.x265.10bit-TEST", 2e9],
      ["720p", "Tears.of.Steel.2012.720p.HDTV.x264-TEST", 1e9],
      ["480p", "Tears.of.Steel.2012.480p.DVDRip.XviD-TEST", 7e8],
    ].map(([q, file, size]) => ({
      name: `Variants\n${q}`,
      title: `${file}\n(test label, plays the 720p file)`,
      url: "https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov",
      behaviorHints: { filename: `${file}.mkv`, videoSize: size },
    })),
  ],
};

http
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/manifest.json") return send(200, manifest);
    const m = url.pathname.match(/^\/stream\/movie\/([^/]+)\.json$/);
    if (m) return send(200, { streams: streams[decodeURIComponent(m[1])] ?? [] });
    send(404, { error: "not found" });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`test addon on http://127.0.0.1:${PORT}/manifest.json`));
