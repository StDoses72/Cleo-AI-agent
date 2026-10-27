import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

async function readObject(path) {
  try {
    const value = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return {}; throw error; }
}
const expandHome = value => value === "~" ? homedir() : value.startsWith("~/") || value.startsWith("~\\") ? resolve(homedir(), value.slice(2)) : value;

// Read the same configured runtime file as Python; only the backend writes it.
export async function readUiLanguage(dataHome, environment = process.env) {
  const home = resolve(environment.CLEO_HOME || dataHome);
  const config = await readObject(resolve(home, expandHome(environment.CLEO_CONFIG_PATH || "config/cleo.json")));
  const directory = config.profiles?.directories?.[config.active_profiles?.directory] ?? {};
  const root = resolve(home, expandHome(typeof directory.root_dir === "string" ? directory.root_dir : "."));
  const state = await readObject(resolve(root, expandHome(typeof directory.runtime_state_path === "string" ? directory.runtime_state_path : "data/runtime.json")));
  return state.ui_language === "en" ? "en" : "zh-CN";
}
