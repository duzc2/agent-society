// 监视窗口:接收 launcher://monitor 事件,渲染服务器状态与智能体计数。
const { listen } = window.__TAURI__.event;

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

listen("launcher://monitor", (event) => {
  const p = event.payload || {};
  const server = typeof p.server === "string" ? p.server : "down";
  dot.className = "dot " + (SERVER_DOT[server] || SERVER_DOT.down);
  statusText.textContent = SERVER_LABEL[server] || SERVER_LABEL.down;
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
