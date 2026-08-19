// 环形仪表皮肤:监听全局 dateUpdate CustomEvent(detail 契约见 classic/main.js 注释)。
// 环比例 = working / total(total 为 0 时比例按 0 处理)。
const CIRC = 2 * Math.PI * 84; // SVG r=84 的周长
const ring = document.getElementById("ring");
const workingEl = document.getElementById("working");
const totalEl = document.getElementById("total");
const statusText = document.getElementById("status-text");

// 初始:空环(在 JS 里设置 dasharray,与 CSS 解耦)
ring.style.strokeDasharray = String(CIRC);
ring.style.strokeDashoffset = String(CIRC);

const SERVER_LABEL = {
  up: "运行中",
  busy: "繁忙",
  down: "端口关闭",
  stopping: "正在停止…",
};

window.addEventListener("dateUpdate", (event) => {
  const p = event.detail || {};
  if (typeof p.working === "number") {
    workingEl.textContent = String(p.working);
  }
  if (typeof p.total === "number") {
    totalEl.textContent = String(p.total);
  }
  if (typeof p.working === "number" && typeof p.total === "number") {
    const ratio = p.total > 0 ? Math.min(1, p.working / p.total) : 0;
    ring.style.strokeDashoffset = String(CIRC * (1 - ratio));
  }
  const server = typeof p.server === "string" ? p.server : "down";
  statusText.textContent = SERVER_LABEL[server] || SERVER_LABEL.down;
});
