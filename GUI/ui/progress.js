// 相位渲染:事件驱动 + 初始状态查询(防止错过窗口创建前的首个事件)
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const els = {
  starting: document.getElementById("phase-starting"),
  failed: document.getElementById("phase-failed"),
  stopping: document.getElementById("phase-stopping"),
  reason: document.getElementById("failed-reason"),
  elapsed: document.getElementById("elapsed"),
};

let elapsedTimer = null;

function show(id) {
  els.starting.hidden = id !== "starting";
  els.failed.hidden = id !== "failed";
  els.stopping.hidden = id !== "stopping";
}

function startTimer() {
  stopTimer();
  const t0 = Date.now();
  els.elapsed.textContent = "0";
  elapsedTimer = setInterval(() => {
    els.elapsed.textContent = String(Math.floor((Date.now() - t0) / 1000));
  }, 1000);
}

function stopTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function applyPhase(payload) {
  let phase = "";
  let message = "";
  if (typeof payload === "string") {
    // launcher_status 的返回格式:"starting" | "ready" | "stopping" | "failed:原因"
    const idx = payload.indexOf(":");
    if (idx >= 0) {
      phase = payload.slice(0, idx);
      message = payload.slice(idx + 1);
    } else {
      phase = payload;
    }
  } else if (payload && typeof payload.phase === "string") {
    phase = payload.phase;
    message = payload.message || "";
  }
  if (phase === "starting") {
    show("starting");
    startTimer();
  } else if (phase === "ready") {
    stopTimer();
  } else if (phase === "failed") {
    stopTimer();
    show("failed");
    els.reason.textContent = message;
  } else if (phase === "stopping") {
    stopTimer();
    show("stopping");
  }
}

listen("launcher://phase", (event) => applyPhase(event.payload));

document.getElementById("btn-retry").onclick = async () => {
  try {
    await invoke("launcher_retry");
  } catch (e) {
    els.reason.textContent = "重试失败: " + e;
  }
};

document.getElementById("btn-exit").onclick = async () => {
  try {
    await invoke("launcher_exit");
  } catch (e) {
    // 应用可能已退出,无需处理
  }
};

(async () => {
  try {
    applyPhase(await invoke("launcher_status"));
  } catch (e) {
    // 初始查询失败不阻塞事件通道
  }
})();
