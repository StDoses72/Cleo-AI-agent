import { createHash } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export const CONTRIBUTION_REPOSITORY = "StDoses72/Cleo-AI-agent";

/** Purpose: Reject missing/protected targets before any remote mutation. Input: branch. Output: canonical branch name. */
export function contributionTarget(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("请选择目标分支；不允许默认提交到 main。");
  const branch = value.trim().replace(/^refs\/heads\//, "");
  if (branch.toLowerCase() === "main") throw new Error("不允许以 main 为 PR 目标分支。");
  if (branch.toLowerCase() === "submission-base") throw new Error("submission-base 是空模板，请从它创建独立的接收分支后再提交 PR。");
  if (branch.length > 200 || branch.startsWith("-") || branch.startsWith("refs/")) throw new Error("目标分支名称无效。");
  return branch;
}

/** Purpose: Validate Git syntax locally. Input: controller, tools, branch. Output: rejection before publishing. */
export async function validateContributionTarget(manager, tools, branch) {
  try { await manager.runCommand(tools.git, ["check-ref-format", `refs/heads/${branch}`], { env: tools.env }); }
  catch { throw new Error("目标分支名称无效，请使用合法的 Git 分支名称。"); }
}

/** Purpose: Require a real upstream target. Input: validated name. Output: verified branch, never a newly created ref. */
export async function requireTargetBranch(manager, tools, branch) {
  let result;
  try {
    result = JSON.parse(await manager.runCommand(tools.gh,
      ["api", `repos/${CONTRIBUTION_REPOSITORY}/branches/${encodeURIComponent(branch)}`, "--method", "GET"], { env: tools.env }));
  } catch (error) {
    if (/HTTP 404/.test(error.message)) throw new Error("目标分支尚未创建或当前账号无权查看，请等待维护者创建。");
    throw error;
  }
  if (result.name !== branch) throw new Error("目标分支尚未创建，请等待维护者创建。");
  return result;
}

/** Purpose: List upstream choices without a main fallback. Input: manager. Output: target branch names. */
export async function listContributionBranches(manager) {
  return manager.operation("checking", async () => {
    const tools = await manager.tools.prepare(true);
    const output = await manager.runCommand(tools.gh, ["api", `repos/${CONTRIBUTION_REPOSITORY}/branches?per_page=100`,
      "--paginate", "--jq", ".[].name"], { env: tools.env });
    return output.split(/\r?\n/).filter((name) => name && !["main", "submission-base"].includes(name.toLowerCase()));
  }, { readOnly: true });
}

/** Purpose: Submit a durable branch-creation application via Issues, without pushing or creating any branch.
 * Input: explicit branch, explanation, selected build and stable request ID. Output: an issue receipt; readiness is checked separately.
 */
export async function requestTargetBranch(manager, { targetBranch, body, buildId, submissionId }) {
  const branch = contributionTarget(targetBranch);
  if (typeof body !== "string" || !body.trim() || body.length > 20000) throw new Error("请填写新建目标分支的申请说明。");
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(submissionId)) throw new Error("申请标识无效。");
  return manager.operation("submitting", async () => {
    const state = await manager.store.read();
    const build = state.builds.find((item) => item.id === buildId && item.kind === "local" && item.sourceHash);
    if (!build) throw new Error("请选择有效的 Cleo 本地版本。");
    const contentHash = createHash("sha256").update(JSON.stringify([branch, body, buildId, build.sourceHash])).digest("hex");
    const previous = state.branchRequests?.find((item) => item.id === submissionId);
    if (previous && previous.contentHash !== contentHash) throw new Error("申请内容已变化，请重新发起。");
    if (previous?.url) return previous;
    const tools = await manager.tools.prepare(true);
    await validateContributionTarget(manager, tools, branch);
    await manager.runCommand(tools.gh, ["auth", "status"], { env: tools.env });
    const user = JSON.parse(await manager.runCommand(tools.gh, ["api", "user"], { env: tools.env }));
    if (previous && previous.owner !== user.login) throw new Error("申请账号已变化，请重新发起。");
    const marker = `<!-- cleo-branch-request:${submissionId} -->`;
    const find = async () => {
      const issues = JSON.parse(await manager.runCommand(tools.gh, ["issue", "list", "--repo", CONTRIBUTION_REPOSITORY,
        "--state", "all", "--author", "@me", "--limit", "1000", "--json", "url,body"], { env: tools.env }));
      return issues.find((issue) => issue.body?.includes(marker))?.url;
    };
    const pending = previous || { id: submissionId, branch, body, buildId, sourceHash: build.sourceHash,
      buildName: build.name || buildId, owner: user.login, contentHash, createdAt: new Date().toISOString(), status: "pending" };
    if (!previous) await manager.store.update({ branchRequests: [...(state.branchRequests || []), pending] });
    let url = await find();
    if (!url) {
      const bodyFile = join(manager.store.root, `branch-request-${submissionId}.md`);
      try {
        await writeFile(bodyFile, `${marker}\n申请创建目标分支：\`${branch}\`\n\n${body}\n\n`
          + `Cleo 本地版本：${pending.buildName}\n源码摘要：${build.sourceHash}\n\n`
          + "这是一份分支创建申请，不代表分支已经创建。请由仓库 owner/collaborator 决定是否创建。"
          + `\n\n创建方式：在 GitHub 的 Create a branch 中，将 Source 设为 \`submission-base\`，分支名称设为 \`${branch}\`。`
          + "请保持新分支为空，不添加 README 或其他文件。"
          + "\n\n创建后，申请人将从自己的 fork 向该分支另行提交完整程序源码快照 PR；不包含本机配置、对话或运行数据，不自动合并。", "utf8");
        try {
          url = await manager.runCommand(tools.gh, ["issue", "create", "--repo", CONTRIBUTION_REPOSITORY,
            "--title", `申请新建目标分支：${branch}`, "--body-file", bodyFile], { env: tools.env });
        } catch (error) { url = await find(); if (!url) throw error; }
      } finally { await rm(bodyFile, { force: true }); }
    }
    if (!new RegExp(`^https://github\\.com/${CONTRIBUTION_REPOSITORY}/issues/\\d+$`, "i").test(url))
      throw new Error("GitHub 未返回有效的申请地址，请重试确认。");
    const receipt = { ...pending, url, status: "requested" };
    const current = await manager.store.read();
    await manager.store.update({ branchRequests: current.branchRequests.map((item) => item.id === submissionId ? receipt : item) });
    return receipt;
  });
}

/** Purpose: Check whether maintainers created an applied-for branch. Input: receipt ID. Output: refreshed readiness only. */
export async function refreshTargetBranch(manager, id) {
  return manager.operation("checking", async () => {
    const state = await manager.store.read();
    const request = state.branchRequests?.find((item) => item.id === id && item.url);
    if (!request) throw new Error("找不到已提交的目标分支申请。");
    const branch = contributionTarget(request.branch);
    const tools = await manager.tools.prepare(true);
    await requireTargetBranch(manager, tools, branch);
    const receipt = { ...request, status: "ready", checkedAt: new Date().toISOString() };
    await manager.store.update({ branchRequests: state.branchRequests.map((item) => item.id === id ? receipt : item) });
    return receipt;
  });
}
