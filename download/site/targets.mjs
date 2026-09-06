export const REPOSITORY = "https://github.com/StDoses72/Cleo-AI-agent";
export const TARGETS = {
  "windows-x64": { label: "Windows · x64", file: "Cleo-windows-x64.zip", checksum: "Cleo-windows-x64.sha256" },
  "macos-arm64": { label: "macOS · Apple Silicon", file: "Cleo-macos-arm64.zip", checksum: "Cleo-macos-arm64.sha256" },
  "macos-x64": { label: "macOS · Intel", file: "Cleo-macos-x64.zip", checksum: "Cleo-macos-x64.sha256" },
  "linux-x64": { label: "Linux · x64", file: "Cleo-linux-x64.tar.gz", checksum: "Cleo-linux-x64.sha256" },
  "linux-deb": { label: "Debian / Ubuntu · x64", file: "Cleo-linux-x64.deb", checksum: "Cleo-linux-x64.deb.sha256" },
};

export function detectTarget({ userAgent = "", platform = "", maxTouchPoints = 0, hints = {} } = {}) {
  if (hints.mobile || /Android|iPhone|iPad|iPod/i.test(userAgent)
      || (/Mac/i.test(platform) && maxTouchPoints > 1)) return { os: "mobile", target: null };
  const source = hints.platform || platform || userAgent;
  const os = /Windows|Win32|Win64/i.test(source) ? "windows"
    : /macOS|Mac/i.test(source) ? "macos"
      : /Linux/i.test(source) ? "linux" : null;
  let arch;
  if (hints.architecture) {
    if (hints.bitness === "64" || hints.wow64) {
      if (/^(arm|arm64|aarch64)$/.test(hints.architecture)) arch = "arm64";
      if (/^(x86|x64|x86_64)$/.test(hints.architecture)) arch = "x64";
    }
    if (hints.bitness === "32" && !hints.wow64) arch = "unsupported";
  } else if (os !== "macos") {
    if (/aarch64|arm64|armv\d/i.test(userAgent)) arch = "arm64";
    else if (/x86_64|x64|Win64|WOW64|amd64/i.test(userAgent)) arch = "x64";
    else if (/i[3-6]86/i.test(userAgent)) arch = "unsupported";
  }
  // Safari reports "Intel Mac" on Apple Silicon too; it cannot establish the chip.
  const target = os && arch ? `${os}-${arch}` : null;
  return { os, arch, target: Object.hasOwn(TARGETS, target) ? target : null };
}

export function releaseInfo(value) {
  if (!value || value.draft || value.prerelease || !/^v\d+\.\d+\.\d+$/.test(value.tag_name)
      || !Array.isArray(value.assets)) throw new Error("Invalid stable release.");
  return { tag: value.tag_name, assets: new Map(value.assets.map((asset) => [asset.name, asset.size])) };
}

export function downloadLinks(target, release = null) {
  const selected = TARGETS[target];
  if (!selected) return null;
  if (release && (!release.assets.has(selected.file) || !release.assets.has(selected.checksum))) return null;
  const base = release ? `${REPOSITORY}/releases/download/${release.tag}` : `${REPOSITORY}/releases/latest/download`;
  return { archive: `${base}/${selected.file}`, checksum: `${base}/${selected.checksum}`,
    bytes: release?.assets.get(selected.file) };
}
