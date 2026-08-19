// 经典卡片皮肤:监听全局 dateUpdate CustomEvent。
// 契约:window 上的 "dateUpdate" 事件,detail = {total, working, server, updated}
//   total/working: number 或 null;server: "up"|"busy"|"down"|"stopping";updated: bool
// 皮肤不依赖 Tauri API;右键菜单由启动器统一注入。
const dot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const updatedEl = document.getElementById("updated");
const totalEl = document.getElementById("total");
const workingEl = document.getElementById("working");

const SERVER_LABEL = {
  up: "运行中",
  busy: "繁忙",
  down: "端口关闭",
  stopping: "正在停止…",
};
const SERVER_DOT = {
  up: "dot-up",
  busy: "dot-busy",
  down: "dot-down",
  stopping: "",
};

window.addEventListener("dateUpdate", (event) => {
  const p = event.detail || {};
  const server = typeof p.server === "string" ? p.server : "down";
  dot.className = "dot " + (SERVER_DOT[server] || SERVER_DOT.down);
  statusText.textContent = SERVER_LABEL[server] || SERVER_LABEL.down;
  // stopping 只带 server,数字保留上次值 → 必须类型守卫
  if (typeof p.total === "number") {
    totalEl.textContent = String(p.total);
  }
  if (typeof p.working === "number") {
    workingEl.textContent = String(p.working);
  }
  if (p.updated) {
    const t = new Date();
    updatedEl.textContent = "更新 " + t.toTimeString().slice(0, 8);
  }
});
