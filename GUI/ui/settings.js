// 设置窗口:两列平铺皮肤卡片(预览图 + 显示名 + 来源角标 + 当前选中高亮),
// 选择后点"应用"立即生效(运行时换肤)。数据来自 settings_get / settings_apply 命令。
const { invoke } = window.__TAURI__.core;

const grid = document.getElementById("skin-grid");
const statusEl = document.getElementById("status");
let selected = null; // 当前选中的皮肤技术键(如 "official:classic")

function sourceBadge(source) {
  return source === "official" ? "官方" : "自定义";
}

async function loadSkins() {
  statusEl.textContent = "加载中…";
  let data;
  try {
    data = await invoke("settings_get");
  } catch (e) {
    statusEl.textContent = "加载失败: " + e;
    return;
  }
  selected = data.current;
  grid.textContent = "";
  for (const skin of data.skins) {
    const card = document.createElement("div");
    card.className = "card";
    if (!skin.valid) card.classList.add("invalid");
    if (skin.key === selected) card.classList.add("selected");

    const imgWrap = document.createElement("div");
    imgWrap.className = "preview-wrap";
    if (skin.preview_ok) {
      const img = document.createElement("img");
      // Windows/WebView2: 自定义协议的子资源请求不会被 wry 自动改写为 workaround 形式,
      // 必须直接用 http://skin.localhost/...(wry 拦截后 revert 回 skin://localhost/... 交给 serve_skin_request)。
      img.src = "http://skin.localhost/" + skin.source + "/" + skin.folder + "/preview.png";
      img.alt = skin.name;
      img.draggable = false;
      img.onerror = () => {
        console.error("皮肤预览图加载失败:", img.src);
        const ph = document.createElement("div");
        ph.className = "preview-placeholder";
        ph.textContent = "预览无效";
        imgWrap.replaceChild(ph, img);
      };
      imgWrap.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "preview-placeholder";
      ph.textContent = skin.valid ? "预览无效" : "无效";
      imgWrap.appendChild(ph);
    }

    const nameEl = document.createElement("div");
    nameEl.className = "skin-name";
    nameEl.textContent = skin.name;
    const meta = document.createElement("div");
    meta.className = "skin-meta";
    meta.textContent = sourceBadge(skin.source) + " · " + skin.folder;

    card.appendChild(imgWrap);
    card.appendChild(nameEl);
    card.appendChild(meta);
    if (skin.error) {
      const errEl = document.createElement("div");
      errEl.className = "skin-error";
      errEl.textContent = skin.error;
      card.appendChild(errEl);
    }
    card.onclick = () => {
      if (!skin.valid) return;
      grid.querySelectorAll(".card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      selected = skin.key;
      statusEl.textContent = '已选择: ' + skin.name + '(点击"应用"生效)';
    };
    grid.appendChild(card);
  }
  const cur = data.skins.find((s) => s.key === data.current);
  statusEl.textContent = cur
    ? "当前皮肤: " + cur.name + "(" + sourceBadge(cur.source) + ")"
    : "当前皮肤: " + data.current;
}

document.getElementById("btn-apply").onclick = async () => {
  if (!selected) {
    statusEl.textContent = "请先选择一个皮肤";
    return;
  }
  try {
    await invoke("settings_apply", { key: selected });
    await loadSkins();
    statusEl.textContent = "已应用,立即生效";
  } catch (e) {
    statusEl.textContent = "应用失败: " + e;
  }
};

document.getElementById("btn-close").onclick = async () => {
  try {
    await invoke("settings_close");
  } catch (e) {
    // 隐藏失败不阻塞(窗口仍在,可手动点 X)
  }
};

loadSkins();
