import { TARGETS, detectTarget, downloadLinks, releaseInfo } from "./targets.mjs";

const select = document.querySelector("#target");
const button = document.querySelector("#download");
const checksum = document.querySelector("#checksum");
const note = document.querySelector("#install-note");
const shell = document.querySelector("#shell");
let release = null;
let manuallySelected = false;
let shellSelected = false;

function render() {
  const target = select.value;
  const links = downloadLinks(target, release);
  button.setAttribute("aria-disabled", String(!links));
  button.textContent = links?.kind === "release" ? "打开官方发布页 ↗"
    : links ? `下载 ${TARGETS[target].label} ${links.kind === "installer" ? "安装器" : "程序包"} ↓` : target ? "当前版本暂无此安装包" : "请选择安装包 ↓";
  button.removeAttribute("href");
  checksum.hidden = !links?.checksum;
  if (links) { button.href = links.archive; if (links.checksum) checksum.href = links.checksum; }
  document.querySelector("#version").textContent = `${release?.tag || "最新稳定版"}${links?.bytes ? ` · ${Math.round(links.bytes / 1_000_000)} MB` : ""}`;
  note.hidden = !target || links?.kind === "release";
  note.textContent = target.startsWith("macos")
    ? `${links?.kind === "installer" ? "双击 PKG，安装到「应用程序」。安装阶段会联网下载并验证运行环境。" : "此版本提供 ZIP：解压后将 Cleo.app 放入「应用程序」。"} 尚未通过 Apple 公证；若提示无法验证，请在确认来源后前往「系统设置 → 隐私与安全性 → 仍要打开」。M 系列芯片请选择 Apple Silicon。`
    : target === "linux-deb" ? "适用于 Debian / Ubuntu x64。双击 DEB，在软件安装程序中完成安装，自动联网准备依赖。也可运行 sudo apt install ./Cleo-linux-x64.deb。"
      : target === "linux-x64" ? "用于已有运行环境的程序更新。Debian / Ubuntu 首次安装请选择 DEB；其他发行版请参阅安装帮助中的源码运行说明。"
        : links?.kind === "installer" ? "双击 EXE，选择安装位置。安装器会联网下载并验证 Python、Node 和后端，完成后从开始菜单打开 Cleo。"
          : "此版本提供 ZIP：解压后运行 Cleo/Cleo.exe。已安装 Cleo 的用户也可以直接在应用内检查更新。";
}

function renderCommand() {
  const windows = shell.value === "windows";
  const url = new URL(windows ? "download.ps1" : "download.sh", location.href).href;
  document.querySelector("#command").textContent = windows
    ? `& ([scriptblock]::Create((Invoke-RestMethod '${url}')))`
    : `curl -fsSL '${url}' | sh`;
  document.querySelector("#script").href = url;
  document.querySelector("#copy-status").textContent = "";
}

select.addEventListener("change", () => { manuallySelected = true; render(); });
shell.addEventListener("change", () => { shellSelected = true; renderCommand(); });
document.querySelector("#copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#command").textContent);
    document.querySelector("#copy-status").textContent = "已复制，粘贴到终端运行。";
  } catch {
    document.querySelector("#copy-status").textContent = "浏览器未允许复制，请选中上方命令手动复制。";
  }
});

async function detect() {
  let hints = navigator.userAgentData || {};
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      hints = await navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "wow64"]);
    }
  } catch { /* Browsers may deny architecture hints; keep the manual selector available. */ }
  const result = detectTarget({ userAgent: navigator.userAgent, platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints, hints });
  if (!manuallySelected && result.target) select.value = result.target;
  if (!shellSelected && result.os === "windows") shell.value = "windows";
  document.querySelector("#detection").textContent = result.target
    ? `根据浏览器信息推荐 ${TARGETS[result.target].label}。你也可以切换安装包。`
    : result.os === "macos" && !result.arch ? "已识别 macOS。请在苹果菜单 → 关于本机查看芯片，选择 Apple Silicon 或 Intel。"
      : result.os === "mobile" ? "Cleo 目前提供桌面版，请在电脑上下载，或为你的电脑选择安装包。"
        : result.arch ? "当前系统架构尚无原生安装包。你仍可为其他电脑选择安装包。"
          : "浏览器未提供完整系统信息，请选择安装包，或使用下方自动检测脚本。";
  render();
  renderCommand();
}

async function loadRelease() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("https://api.github.com/repos/StDoses72/Cleo-AI-agent/releases/latest", { signal: controller.signal });
    if (!response.ok) throw new Error("Release unavailable");
    release = releaseInfo(await response.json());
  } catch {
    document.querySelector("#release-status").textContent = "暂时无法读取版本信息。请打开官方发布页，选择对应系统的安装器。";
  } finally { clearTimeout(timeout); }
  render();
}

renderCommand();
void detect();
void loadRelease();
