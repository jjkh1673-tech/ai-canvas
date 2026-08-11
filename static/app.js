const $ = (s) => document.querySelector(s);

const chatEl = $("#chat");
const input = $("#input");
const sendBtn = $("#sendBtn");
const modelSelect = $("#modelSelect");

const KEY = "ai_canvas_chats_v3";

let chats = loadChats();
let currentId = null;
let messages = [];
let attachments = [];
let busy = false;

function loadChats() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

function saveChats() {
  localStorage.setItem(KEY, JSON.stringify(chats));

  const state = $("#saveState");
  if (state) state.textContent = "Saved locally";
}

function uid() {
  if (window.crypto?.randomUUID) {
    return crypto.randomUUID();
  }

  return (
    Date.now() +
    "-" +
    Math.random().toString(16).slice(2)
  );
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c]
  );
}

function md(s) {
  let x = escapeHtml(s);

  x = x.replace(
    /```([\s\S]*?)```/g,
    (_, c) => `<pre><code>${c.trim()}</code></pre>`
  );

  x = x.replace(
    /`([^`]+)`/g,
    "<code>$1</code>"
  );

  x = x.replace(
    /\*\*([^*]+)\*\*/g,
    "<strong>$1</strong>"
  );

  x = x.replace(
    /\*([^*]+)\*/g,
    "<em>$1</em>"
  );

  x = x.replace(/\n/g, "<br>");

  return x;
}

function toast(message) {
  const t = $("#toast");

  if (!t) return;

  t.textContent = message;
  t.classList.add("show");

  setTimeout(() => {
    t.classList.remove("show");
  }, 2200);
}

function resize() {
  if (!input) return;

  input.style.height = "auto";
  input.style.height =
    Math.min(input.scrollHeight, 180) + "px";
}

if (input) {
  input.addEventListener("input", resize);
}

function makeChat() {
  const id = uid();

  return {
    id,
    title: "New chat",
    created: Date.now(),
    updated: Date.now(),
    messages: [],
  };
}

function current() {
  return chats.find((c) => c.id === currentId);
}

function renderHistory() {
  const search = $("#chatSearch");
  const box = $("#history");

  if (!box) return;

  const q = (search?.value || "").toLowerCase();

  box.innerHTML = "";

  chats
    .filter((c) =>
      String(c.title || "")
        .toLowerCase()
        .includes(q)
    )
    .sort((a, b) => b.updated - a.updated)
    .forEach((c) => {
      const row = document.createElement("div");

      row.className =
        "history-row" +
        (c.id === currentId ? " active" : "");

      row.innerHTML = `
        <button class="chat-item">
          <span class="chat-icon">▱</span>
          <span class="chat-title">
            ${escapeHtml(c.title)}
          </span>
        </button>

        <button
          class="more-btn"
          title="Chat options"
          type="button"
        >
          ⋯
        </button>
      `;

      row
        .querySelector(".chat-item")
        .addEventListener("click", () =>
          openChat(c.id)
        );

      row
        .querySelector(".more-btn")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          openMenu(e, c.id);
        });

      box.appendChild(row);
    });
}

function openMenu(e, id) {
  const m = $("#contextMenu");

  if (!m) return;

  m.innerHTML = `
    <button data-act="rename" type="button">
      ✎ Rename
    </button>

    <button data-act="download" type="button">
      ⇩ Download workspace
    </button>

    <button
      data-act="delete"
      class="danger"
      type="button"
    >
      ⌫ Delete chat
    </button>
  `;

  m.style.left =
    Math.min(
      e.clientX,
      window.innerWidth - 220
    ) + "px";

  m.style.top =
    Math.min(
      e.clientY,
      window.innerHeight - 150
    ) + "px";

  m.classList.add("show");

  m.querySelector(
    '[data-act="rename"]'
  ).onclick = () => {
    const c = chats.find((x) => x.id === id);

    if (!c) return;

    const n = prompt(
      "Rename chat",
      c.title
    );

    if (n?.trim()) {
      c.title = n.trim();
      c.updated = Date.now();

      saveChats();
      renderHistory();
    }

    m.classList.remove("show");
  };

  m.querySelector(
    '[data-act="download"]'
  ).onclick = () => {
    m.classList.remove("show");
    downloadChat(id);
  };

  m.querySelector(
    '[data-act="delete"]'
  ).onclick = () => {
    if (
      confirm(
        "Delete this chat from local history?"
      )
    ) {
      chats = chats.filter(
        (x) => x.id !== id
      );

      if (currentId === id) {
        newChat();
      }

      saveChats();
      renderHistory();
    }

    m.classList.remove("show");
  };
}

document.addEventListener("click", (e) => {
  const menu = $("#contextMenu");

  if (
    menu &&
    !e.target.closest(
      ".context-menu,.more-btn"
    )
  ) {
    menu.classList.remove("show");
  }
});

function renderMessages() {
  if (!chatEl) return;

  chatEl.innerHTML = "";

  if (!messages.length) {
    chatEl.innerHTML = `
      <div class="hero" id="hero">
        <div class="hero-orb">✦</div>

        <h1>What will you build?</h1>

        <p>
          Chat, upload files, create outputs,
          and export the entire workspace.
        </p>

        <div class="suggestions">

          <button
            data-prompt="Analyze my project architecture and suggest improvements."
            type="button"
          >
            Analyze architecture
          </button>

          <button
            data-prompt="Review my code and find bugs."
            type="button"
          >
            Review code
          </button>

          <button
            data-prompt="Create a practical step-by-step plan."
            type="button"
          >
            Make a plan
          </button>

          <button
            data-prompt="Create a downloadable Markdown report from this conversation."
            type="button"
          >
            Create report
          </button>

        </div>
      </div>
    `;

    bindSuggestions();
    return;
  }

  messages.forEach((m) => {
    addMessage(
      m.role,
      m.content,
      false
    );
  });

  chatEl.scrollTop =
    chatEl.scrollHeight;
}

function addMessage(
  role,
  text,
  scroll = true
) {
  $("#hero")?.remove();

  const row =
    document.createElement("div");

  row.className =
    `msg-row ${role}`;

  const av =
    document.createElement("div");

  av.className = "avatar";

  av.textContent =
    role === "user"
      ? "You"
      : "✦";

  const bubble =
    document.createElement("div");

  bubble.className = "bubble";

  bubble.innerHTML = md(text);

  row.append(av, bubble);

  chatEl.appendChild(row);

  if (scroll) {
    chatEl.scrollTop =
      chatEl.scrollHeight;
  }

  return {
    row,
    bubble,
  };
}

function addTool(name, result) {
  const row =
    document.createElement("div");

  row.className =
    "msg-row tool-row";

  row.innerHTML = `
    <div class="avatar">⚙</div>

    <div class="bubble">

      <div class="tool-card">

        <b>
          ⚙ ${escapeHtml(name)}
        </b>

        <span>
          ${escapeHtml(
            String(result || "")
          ).slice(0, 900)}
        </span>

      </div>

    </div>
  `;

  chatEl.appendChild(row);

  chatEl.scrollTop =
    chatEl.scrollHeight;
}

function newChat() {
  const c = makeChat();

  chats.unshift(c);

  currentId = c.id;

  messages = [];
  attachments = [];

  renderMessages();
  renderAttachments();
  renderHistory();

  saveChats();

  $("#sidebar")?.classList.remove(
    "open"
  );

  input?.focus();
}

function openChat(id) {
  const c = chats.find(
    (x) => x.id === id
  );

  if (!c) return;

  currentId = id;

  messages = c.messages || [];
  attachments = [];

  renderMessages();
  renderAttachments();
  renderHistory();

  $("#sidebar")?.classList.remove(
    "open"
  );
}

function updateCurrent() {
  const c = current();

  if (!c) return;

  c.messages = messages;
  c.updated = Date.now();

  if (
    messages.length &&
    c.title === "New chat"
  ) {
    const first =
      messages.find(
        (m) => m.role === "user"
      )?.content ||
      "New chat";

    c.title = first
      .replace(/\s+/g, " ")
      .slice(0, 52);
  }

  saveChats();
  renderHistory();
}

async function loadModels() {
  try {
    const r =
      await fetch(
        "/api/models",
        {
          method: "GET",
          cache: "no-store",
          headers: {
            Accept:
              "application/json",
          },
        }
      );

    if (!r.ok) {
      throw new Error(
        `HTTP ${r.status}`
      );
    }

    const d = await r.json();

    modelSelect.innerHTML = "";

    (d.models || []).forEach(
      (m) => {
        const o =
          document.createElement(
            "option"
          );

        o.value = m;
        o.textContent = m;

        modelSelect.appendChild(o);
      }
    );

    const preferred =
      (d.models || []).find(
        (m) =>
          m
            .toLowerCase()
            .includes("luna")
      ) ||
      d.models?.[0];

    if (preferred) {
      modelSelect.value =
        preferred;
    }
  } catch (e) {
    console.error(
      "Model loading failed:",
      e
    );

    toast(
      "Could not load models"
    );
  }
}

async function health() {
  try {
    const r =
      await fetch(
        "/api/health",
        {
          method: "GET",
          cache: "no-store",
          headers: {
            Accept:
              "application/json",
          },
        }
      );

    if (!r.ok) {
      throw new Error(
        `HTTP ${r.status}`
      );
    }

    const d =
      await r.json();

    const dot =
      $("#healthDot");

    const text =
      $("#healthText");

    if (dot) {
      dot.style.background =
        d.api_configured
          ? "#5eead4"
          : "#ffb86b";
    }

    if (text) {
      text.textContent =
        d.api_configured
          ? "Gateway connected"
          : "API key missing";
    }
  } catch (e) {
    console.error(
      "Health check failed:",
      e
    );

    const text =
      $("#healthText");

    if (text) {
      text.textContent =
        "Server unavailable";
    }
  }
}

function setBusy(v) {
  busy = v;

  if (sendBtn) {
    sendBtn.disabled = v;
    sendBtn.textContent =
      v ? "…" : "➤";
  }

  if (input) {
    input.disabled = v;
  }

  const attach =
    $("#attachBtn");

  if (attach) {
    attach.disabled = v;
  }
}

async function uploadFiles(
  fileList
) {
  if (!currentId) {
    newChat();
  }

  const files = [
    ...fileList,
  ];

  if (!files.length) return;

  const fd =
    new FormData();

  fd.append(
    "chat_id",
    currentId
  );

  files.forEach((f) =>
    fd.append("files", f)
  );

  try {
    const r =
      await fetch(
        "/api/upload",
        {
          method: "POST",
          body: fd,
        }
      );

    if (!r.ok) {
      throw new Error(
        await r.text()
      );
    }

    const d =
      await r.json();

    attachments.push(
      ...(d.files || [])
    );

    renderAttachments();

    toast(
      `${d.files?.length || 0} file(s) uploaded`
    );
  } catch (e) {
    console.error(
      "Upload failed:",
      e
    );

    toast(
      "Upload failed: " +
        e.message
    );
  }
}

function renderAttachments() {
  const box =
    $("#attachments");

  if (!box) return;

  box.innerHTML = "";

  attachments.forEach(
    (f, i) => {
      const el =
        document.createElement(
          "div"
        );

      el.className =
        "attachment";

      el.innerHTML = `
        <span>📎</span>

        <span>
          ${escapeHtml(
            f.name
          )}
        </span>

        <button
          title="Remove"
          type="button"
        >
          ×
        </button>
      `;

      el.querySelector(
        "button"
      ).onclick = () => {
        attachments.splice(
          i,
          1
        );

        renderAttachments();
      };

      box.appendChild(el);
    }
  );
}

function parseSSEBlock(raw) {
  const lines =
    raw.split(/\r?\n/);

  let eventName = "message";
  const dataLines = [];

  for (const line of lines) {
    if (
      line.startsWith(
        "event:"
      )
    ) {
      eventName =
        line
          .slice(6)
          .trim();
    }

    if (
      line.startsWith(
        "data:"
      )
    ) {
      dataLines.push(
        line
          .slice(5)
          .trimStart()
      );
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const rawData =
    dataLines.join("\n");

  let data;

  try {
    data =
      JSON.parse(rawData);
  } catch {
    data = {
      text: rawData,
    };
  }

  return {
    event: eventName,
    data,
  };
}

async function send(text) {
  if (
    busy ||
    !text ||
    !text.trim()
  ) {
    return;
  }

  if (!currentId) {
    newChat();
  }

  text = text.trim();

  const extra =
    attachments.length
      ? `\n\n[Attached files: ${attachments
          .map(
            (x) =>
              x.stored || x.name
          )
          .join(", ")}]`
      : "";

  addMessage(
    "user",
    text
  );

  messages.push({
    role: "user",
    content:
      text + extra,
  });

  attachments = [];

  renderAttachments();

  const ai =
    addMessage(
      "assistant",
      ""
    );

  ai.bubble.innerHTML =
    '<span class="thinking">Thinking…</span>';

  setBusy(true);

  let answer = "";

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      180000
    );

  try {
    /*
     * IMPORTANT:
     * No SharedWorker.
     * No Worker.
     * No external reconnect library.
     *
     * Direct browser -> FastAPI SSE.
     */

    const payload = {
      chat_id: currentId,
      model:
        modelSelect?.value ||
        "",
      messages:
        messages,
      tools_enabled:
        $("#toolsToggle")
          ?.checked !== false,
    };

    const res =
      await fetch(
        "/api/chat/stream",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Accept:
              "text/event-stream",

            "Cache-Control":
              "no-cache",

            "X-Requested-With":
              "XMLHttpRequest",
          },

          cache: "no-store",

          credentials: "same-origin",

          signal:
            controller.signal,

          body:
            JSON.stringify(
              payload
            ),
        }
      );

    if (!res.ok) {
      let detail = "";

      try {
        detail =
          await res.text();
      } catch {}

      throw new Error(
        `Server returned HTTP ${res.status}` +
          (detail
            ? `: ${detail.slice(
                0,
                700
              )}`
            : "")
      );
    }

    /*
     * If the server does not provide
     * a readable stream, try normal
     * JSON/text response instead.
     */

    if (!res.body) {
      const raw =
        await res.text();

      if (!raw) {
        throw new Error(
          "The server returned an empty response."
        );
      }

      try {
        const json =
          JSON.parse(raw);

        answer =
          json.answer ||
          json.response ||
          json.message ||
          json.content ||
          "";

        if (!answer) {
          throw new Error(
            "No AI response was found."
          );
        }
      } catch {
        answer = raw;
      }

      ai.bubble.innerHTML =
        md(answer);

      messages.push({
        role: "assistant",
        content: answer,
      });

      updateCurrent();

      return;
    }

    const reader =
      res.body.getReader();

    const decoder =
      new TextDecoder(
        "utf-8"
      );

    let buffer = "";

    while (true) {
      const {
        value,
        done,
      } =
        await reader.read();

      if (done) break;

      buffer += decoder.decode(
        value,
        {
          stream: true,
        }
      );

      /*
       * SSE events are separated
       * by a blank line.
       */
      const events =
        buffer.split(
          /\r?\n\r?\n/
        );

      buffer =
        events.pop() || "";

      for (const raw of events) {
        const parsed =
          parseSSEBlock(
            raw
          );

        if (!parsed) continue;

        const {
          event,
          data,
        } = parsed;

        /*
         * TOKEN
         */
        if (
          event === "token" ||
          event === "message"
        ) {
          const token =
            data.text ??
            data.content ??
            data.token ??
            "";

          if (token) {
            answer += token;

            ai.bubble.innerHTML =
              md(answer) +
              '<span class="cursor"></span>';

            chatEl.scrollTop =
              chatEl.scrollHeight;
          }
        }

        /*
         * TOOL START
         */
        else if (
          event ===
          "tool_start"
        ) {
          addTool(
            data.name ||
              "Agent tool",
            "Running…"
          );
        }

        /*
         * TOOL RESULT
         */
        else if (
          event ===
          "tool_result"
        ) {
          addTool(
            data.name ||
              "Agent tool",
            data.result ||
              data.output ||
              ""
          );
        }

        /*
         * STATUS
         */
        else if (
          event === "status"
        ) {
          if (!answer) {
            ai.bubble.innerHTML =
              `<span class="thinking">${escapeHtml(
                data.message ||
                  data.status ||
                  "Working…"
              )}</span>`;
          }
        }

        /*
         * ERROR
         */
        else if (
          event === "error"
        ) {
          throw new Error(
            data.message ||
              data.error ||
              "The agent returned an error."
          );
        }

        /*
         * DONE
         */
        else if (
          event === "done"
        ) {
          // Stream completed.
        }
      }
    }

    /*
     * Flush remaining decoder data.
     */
    buffer +=
      decoder.decode();

    if (buffer.trim()) {
      const parsed =
        parseSSEBlock(
          buffer
        );

      if (parsed) {
        const {
          event,
          data,
        } = parsed;

        if (
          event === "token" ||
          event === "message"
        ) {
          const token =
            data.text ??
            data.content ??
            data.token ??
            "";

          if (token) {
            answer += token;
          }
        }

        if (
          event === "error"
        ) {
          throw new Error(
            data.message ||
              data.error ||
              "The agent returned an error."
          );
        }
      }
    }

    if (!answer) {
      throw new Error(
        "The connection closed before the AI returned a response."
      );
    }

    ai.bubble.innerHTML =
      md(answer);

    messages.push({
      role: "assistant",
      content: answer,
    });

    updateCurrent();
  } catch (e) {
    console.error(
      "AI request failed:",
      e
    );

    let msg =
      e?.name ===
      "AbortError"
        ? "The AI request timed out after 3 minutes."
        : e?.message ||
          String(e);

    /*
     * Make common browser/network
     * failures understandable.
     */
    if (
      msg ===
        "Failed to fetch" ||
      msg.includes(
        "NetworkError"
      )
    ) {
      msg =
        "Could not connect to the AI service. Please try again.";
    }

    ai.bubble.innerHTML = `
      <span class="error-text">
        ${escapeHtml(msg)}
      </span>
    `;

    toast(msg);
  } finally {
    clearTimeout(timeout);

    setBusy(false);

    input?.focus();
  }
}

async function downloadChat(
  id = currentId
) {
  const c =
    chats.find(
      (x) => x.id === id
    );

  if (!c) return;

  try {
    const r =
      await fetch(
        "/api/download",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          credentials:
            "same-origin",

          body:
            JSON.stringify({
              chat_id: id,
              title: c.title,
              messages:
                c.messages || [],
            }),
        }
      );

    if (!r.ok) {
      throw new Error(
        await r.text()
      );
    }

    const blob =
      await r.blob();

    const url =
      URL.createObjectURL(
        blob
      );

    const a =
      document.createElement(
        "a"
      );

    a.href = url;

    a.download =
      (
        c.title.replace(
          /[^\w.-]+/g,
          "_"
        ) ||
        "AI_Canvas_Chat"
      ) + ".zip";

    document.body.appendChild(
      a
    );

    a.click();

    a.remove();

    setTimeout(
      () =>
        URL.revokeObjectURL(
          url
        ),
      1000
    );

    toast(
      "Workspace download started"
    );
  } catch (e) {
    console.error(
      "Download failed:",
      e
    );

    toast(
      "Download failed: " +
        e.message
    );
  }
}

function bindSuggestions() {
  document
    .querySelectorAll(
      "[data-prompt]"
    )
    .forEach((b) => {
      b.onclick = () => {
        input.value =
          b.dataset.prompt;

        resize();

        input.focus();
      };
    });
}

/* Composer */
const composer =
  $("#composer");

if (composer) {
  composer.onsubmit = (
    e
  ) => {
    e.preventDefault();

    const value =
      input.value;

    input.value = "";

    resize();

    send(value);
  };
}

/* Enter = send, Shift+Enter = newline */
if (input) {
  input.onkeydown = (
    e
  ) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey
    ) {
      e.preventDefault();

      composer?.requestSubmit();
    }
  };
}

/* New chat */
$("#newChat")?.addEventListener(
  "click",
  newChat
);

/* Download current chat */
$("#downloadTop")?.addEventListener(
  "click",
  () => downloadChat()
);

/* Clear current chat */
$("#clearBtn")?.addEventListener(
  "click",
  () => {
    messages = [];

    updateCurrent();

    renderMessages();

    toast(
      "Current chat cleared"
    );
  }
);

/* Mobile sidebar */
$("#menuBtn")?.addEventListener(
  "click",
  () =>
    $("#sidebar")?.classList.toggle(
      "open"
    )
);

/* Search */
$("#chatSearch")?.addEventListener(
  "input",
  renderHistory
);

/* Clear history */
$("#clearHistory")?.addEventListener(
  "click",
  () => {
    if (
      confirm(
        "Clear all local chat history?"
      )
    ) {
      chats = [];

      newChat();

      saveChats();

      renderHistory();
    }
  }
);

/* File picker */
$("#attachBtn")?.addEventListener(
  "click",
  () =>
    $("#fileInput")?.click()
);

$("#fileInput")?.addEventListener(
  "change",
  (e) => {
    uploadFiles(
      e.target.files
    );

    /*
     * Allow selecting the
     * same file again later.
     */
    e.target.value = "";
  }
);

/*
 * Drag & Drop
 *
 * IMPORTANT:
 * No SharedWorker.
 * No ServiceWorker.
 * No Worker.
 */
document.addEventListener(
  "dragover",
  (e) => {
    e.preventDefault();
  }
);

document.addEventListener(
  "drop",
  (e) => {
    e.preventDefault();

    if (
      e.dataTransfer?.files
        ?.length
    ) {
      uploadFiles(
        e.dataTransfer.files
      );
    }
  }
);

/* Initialize application */
if (!chats.length) {
  newChat();
} else {
  const latest =
    [...chats].sort(
      (a, b) =>
        b.updated - a.updated
    )[0];

  openChat(latest.id);
}

bindSuggestions();

loadModels();

health();

/*
 * Periodic health check.
 * This does NOT create a worker
 * or background thread.
 */
setInterval(
  health,
  30000
);
