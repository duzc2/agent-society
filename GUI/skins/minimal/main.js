// 极简数字皮肤:监听全局 dateUpdate CustomEvent(detail 契约见 classic/main.js 注释)。
const totalEl = document.getElementById("total");
const workingEl = document.getElementById("working");
const statusText = document.getElementById("status-text");

const SERVER_LABEL = {
  up: "运行中",
  busy: "繁忙",
  down: "端口关闭",
  stopping: "正在停止…",
};

window.addEventListener("dateUpdate", (event) => {
  const p = event.detail || {};
  if (typeof p.total === "number") {
    totalEl.textContent = String(p.total);
  }
  if (typeof p.working === "number") {
    workingEl.textContent = String(p.working);
  }
  const server = typeof p.server === "string" ? p.server : "down";
  statusText.textContent = SERVER_LABEL[server] || SERVER_LABEL.down;
});
