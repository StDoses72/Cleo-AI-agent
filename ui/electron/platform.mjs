import { posix, win32 } from "node:path";

export function desktopPlatform(platform = process.platform, arch = process.arch) {
  if (!((platform === "win32" && arch === "x64")
      || (platform === "darwin" && ["x64", "arm64"].includes(arch))
      || (platform === "linux" && arch === "x64"))) {
    throw new Error(`Unsupported desktop target: ${platform}/${arch}`);
  }
  const name = { win32: "windows", darwin: "macos", linux: "linux" }[platform];
  const id = `${name}-${arch}`;
  return {
    platform, arch, id,
    archive: `Cleo-${id}.${platform === "linux" ? "tar.gz" : "zip"}`,
    manifest: platform === "win32" ? "release.json" : `release-${id}.json`,
    bundle: platform === "darwin" ? "Cleo.app" : "Cleo",
    executable: platform === "darwin" ? "Contents/MacOS/Cleo"
      : platform === "win32" ? "Cleo.exe" : "Cleo",
    resources: platform === "darwin" ? "Contents/Resources" : "resources",
  };
}

export function desktopDataHome({ platform, environment, home, userData }) {
  const path = platform === "win32" ? win32 : posix;
  if (environment.CLEO_HOME) {
    const value = environment.CLEO_HOME;
    return path.resolve(value === "~" ? home
      : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  }
  if (platform === "win32") {
    return environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, "Cleo") : userData;
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Cleo");
  const data = environment.XDG_DATA_HOME;
  return path.join(data && path.isAbsolute(data) ? data : path.join(home, ".local", "share"), "Cleo");
}

export function bundledPython(resources, platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  return platform === "win32" ? path.join(resources, "python", "python.exe")
    : path.join(resources, "python", "bin", "python3");
}

export function harnessPath(paths, environment, platform, home) {
  const path = platform === "win32" ? win32 : posix;
  return [...new Set([
    paths.python ? (platform === "win32"
      ? (path.basename(path.dirname(paths.python)).toLowerCase() === "scripts"
        ? path.dirname(paths.python) : path.join(path.dirname(paths.python), "Scripts"))
      : path.dirname(paths.python)) : null,
    paths.browserRoot,
    paths.browserRoot ? path.join(paths.browserRoot, "node_modules", ".bin") : null,
    platform === "win32" && environment.APPDATA ? path.join(environment.APPDATA, "npm") : null,
    environment.NVM_BIN,
    platform !== "win32" && home ? path.join(home, ".local", "bin") : null,
    platform !== "win32" && home ? path.join(home, ".npm-global", "bin") : null,
    platform === "darwin" ? "/opt/homebrew/bin" : null,
    platform !== "win32" ? "/usr/local/bin" : null,
    environment.PATH,
  ].filter(Boolean))].join(platform === "win32" ? ";" : ":");
}

export function installationRoot(executable, target = desktopPlatform()) {
  const path = target.platform === "win32" ? win32 : posix;
  const root = target.platform === "darwin"
    ? path.resolve(path.dirname(executable), "../..") : path.dirname(executable);
  if (path.resolve(root, target.executable) !== path.resolve(executable)
      || (target.platform === "darwin" && !root.endsWith(".app"))) {
    throw new Error("The executable does not match the expected Cleo package layout.");
  }
  return root;
}
