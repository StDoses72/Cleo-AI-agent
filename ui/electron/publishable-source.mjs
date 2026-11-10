/** Purpose: Exclude machine state even if accidentally tracked. Input: repository path. Output: publishable source flag. */
export function isPublishableSource(name) {
  return !/^(?:data|config|release|dist|build|workspace|\.git|\.venv|\.release-build|\.test-deps)(?:\/|$)/.test(name)
    && !/^\.(?:env(?:\.|$)|local-preview-)/.test(name)
    && !/^memory\/(?!MEMORY_POLICY\.md$)/.test(name)
    && !/^cleo\/config\/(?:cleo|harnesses)\.json$/.test(name)
    && !/(?:^|\/)(?:node_modules|__pycache__|\.pytest_cache|\.ruff_cache)(?:\/|$)/.test(name)
    && !/^ui\/(?:dist|output|\.npm-cache)(?:\/|$)/.test(name)
    && !/^ui\/runtime\/(?!package(?:-lock)?\.json$)/.test(name)
    && !/\.(?:pyc|tsbuildinfo|sqlite3?(?:-wal|-shm)?)$/.test(name);
}
