import assert from "node:assert/strict";

export async function checkSettingsLayout(page) {
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished));
  });
  const navigation = settings.getByRole("navigation", { name: "设置导航" });
  const pages = [
    ["外观", "外观"], ["Agent", "Agent"], ["Agent 指令", "Agent 指令"],
    ["当前配置", "当前配置"], ["新增连接", "新增连接"], ["DreamAgent", "DreamAgent"],
    ["更新", "软件更新"], ["数据与记忆", "数据与记忆"],
  ];
  let baseline;
  for (const [label, title] of pages) {
    await navigation.getByRole("button", { name: label, exact: true }).click();
    await settings.getByRole("heading", { name: title, exact: true }).waitFor();
    const state = await page.evaluate(() => {
      const box = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height].map(value => Math.round(value * 100) / 100);
      };
      const modal = document.querySelector(".settings-modal");
      const heading = modal.querySelector(".settings-header h2");
      const scroll = modal.querySelector(".settings-scroll");
      return {
        layout: [modal, modal.querySelector("aside"), modal.querySelector("nav"),
          modal.querySelector(".settings-header"), modal.querySelector(".settings-close"), scroll,
          ...modal.querySelectorAll("nav button"),
        ].map(box),
        titlePosition: box(heading).slice(0, 2),
        titleStyle: [getComputedStyle(heading).fontSize, getComputedStyle(heading).fontWeight],
        headerCount: modal.querySelectorAll(".settings-header").length,
        current: [...modal.querySelectorAll('nav button[aria-current="page"]')].map(button => button.textContent),
        selectedCount: modal.querySelectorAll("nav button.active").length,
        horizontalOverflow: scroll.scrollWidth > scroll.clientWidth,
        scrollTop: scroll.scrollTop,
      };
    });
    baseline ??= state;
    assert.deepEqual(state.layout, baseline.layout, `Settings shell moved on ${label}`);
    assert.deepEqual(state.titlePosition, baseline.titlePosition, `Settings title moved on ${label}`);
    assert.deepEqual(state.titleStyle, baseline.titleStyle, `Settings title style changed on ${label}`);
    assert.equal(state.headerCount, 1);
    assert.deepEqual(state.current, [label]);
    assert.equal(state.selectedCount, 1);
    assert.equal(state.horizontalOverflow, false, `Settings content overflowed on ${label}`);
    assert.equal(state.scrollTop, 0, `Settings content did not reset on ${label}`);
    await settings.locator(".settings-scroll").evaluate(element => { element.scrollTop = element.scrollHeight; });
    const fixedHeader = await settings.locator(".settings-header").evaluate(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].map(value => Math.round(value * 100) / 100);
    });
    assert.deepEqual(fixedHeader, baseline.layout[3], `Settings header scrolled away on ${label}`);
  }
  await navigation.getByRole("button", { name: "外观", exact: true }).click();
}
