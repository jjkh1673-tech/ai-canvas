
const $ = s => document.querySelector(s);

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
let activeController = null;

function loadChats() {
    try {
        return JSON.parse(localStorage.getItem(KEY) || "[]");
    } catch {
        return [];
    }
}

function saveChats() {
    try {
        localStorage.setItem(KEY, JSON.stringify(chats));
        const state = $("#saveState");
        if (state) state.textContent = "Saved locally";
    } catch (e) {
        console.warn("Could not save chats:", e);
    }
}

function uid() {
    try {
        if (crypto?.randomUUID) return crypto.randomUUID();
    } catch {}
    return Date.now() + "-" + Math.random().toString(16).slice(2);
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[c]));
}

/*
 * Lightweight Markdown renderer.
 * Never renders raw model HTML.
 */
function md(text) {
    let x = escapeHtml(text ?? "");

    x = x.replace(
        /```([\s\S]*?)```/g,
        (_, code) => `<pre><code>${code.trim()}</code></pre>`
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

    clearTimeout(t.__timer);

    t.__timer = setTimeout(() => {
        t.classList.remove("show");
    }, 2600);
}

function resize() {
    if (!input) return;

    input.style.height = "auto";
    input.style.height =
        Math.min(input.scrollHeight, 180) + "px";
}

input?.addEventListener("input", resize);

function makeChat() {
    const id = uid();

    return {
        id,
        title: "New chat",
        created: Date.now(),
        updated: Date.now(),
        messages: []
    };
}

function current() {
    return chats.find(c => c.id === currentId);
}

function renderHistory() {
    const q = ($("#chatSearch")?.value || "").toLowerCase();
    const box = $("#history");

    if (!box) return;

    box.innerHTML = "";

    chats
        .filter(c =>
            String(c.title || "")
                .toLowerCase()
                .includes(q)
        )
        .sort((a, b) => b.updated - a.updated)
        .forEach(c => {
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
                >⋯</button>
            `;

            row.querySelector(".chat-item").onclick =
                () => openChat(c.id);

            row.querySelector(".more-btn").onclick =
                e => {
                    e.stopPropagation();
                    openMenu(e, c.id);
                };

            box.appendChild(row);
        });
}

function openMenu(e, id) {
    const menu = $("#contextMenu");

    if (!menu) return;

    menu.innerHTML = `
        <button data-act="rename">
            ✎ Rename
        </button>

        <button data-act="download">
            ⇩ Download workspace
        </button>

        <button data-act="delete" class="danger">
            ⌫ Delete chat
        </button>
    `;

    menu.style.left =
        Math.min(e.clientX, innerWidth - 220) + "px";

    menu.style.top =
        Math.min(e.clientY, innerHeight - 150) + "px";

    menu.classList.add("show");

    menu.querySelector('[data-act="rename"]').onclick = () => {
        const chat = chats.find(x => x.id === id);

        if (chat) {
            const name = prompt(
                "Rename chat",
                chat.title
            );

            if (name?.trim()) {
                chat.title = name.trim();
                chat.updated = Date.now();

                saveChats();
                renderHistory();
            }
        }

        menu.classList.remove("show");
    };

    menu.querySelector('[data-act="download"]').onclick = () => {
        menu.classList.remove("show");
        downloadChat(id);
    };

    menu.querySelector('[data-act="delete"]').onclick = () => {
        if (
            confirm(
                "Delete this chat from local history?"
            )
        ) {
            chats = chats.filter(x => x.id !== id);

            if (currentId === id) {
                newChat();
            }

            saveChats();
            renderHistory();
        }

        menu.classList.remove("show");
    };
}

document.addEventListener("click", e => {
    if (
        !e.target.closest(
            ".context-menu,.more-btn"
        )
    ) {
        $("#contextMenu")?.classList.remove("show");
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
                    >
                        Analyze architecture
                    </button>

                    <button
                        data-prompt="Review my code and find bugs."
                    >
                        Review code
                    </button>

                    <button
                        data-prompt="Create a practical step-by-step plan."
                    >
                        Make a plan
                    </button>

                    <button
                        data-prompt="Create a downloadable Markdown report from this conversation."
                    >
                        Create report
                    </button>

                </div>
            </div>
        `;

        bindSuggestions();
        return;
    }

    messages.forEach(m => {
        addMessage(
            m.role,
            m.content,
            false
        );
    });

    chatEl.scrollTop = chatEl.scrollHeight;
}

function addMessage(role, text, scroll = true) {
    $("#hero")?.remove();

    const row =
        document.createElement("div");

    row.className =
        `msg-row ${role}`;

    const avatar =
        document.createElement("div");

    avatar.className = "avatar";

    avatar.textContent =
        role === "user"
            ? "You"
            : "✦";

    const bubble =
        document.createElement("div");

    bubble.className = "bubble";

    bubble.innerHTML =
        md(text);

    row.append(
        avatar,
        bubble
    );

    chatEl.appendChild(row);

    if (scroll) {
        chatEl.scrollTop =
            chatEl.scrollHeight;
    }

    return {
        row,
        bubble
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
                    ${escapeHtml(result).slice(0, 900)}
                </span>

            </div>

        </div>
    `;

    chatEl.appendChild(row);

    chatEl.scrollTop =
        chatEl.scrollHeight;
}

function newChat() {
    if (activeController) {
        try {
            activeController.abort();
        } catch {}
    }

    const c = makeChat();

    chats.unshift(c);

    currentId = c.id;

    messages = [];
    attachments = [];

    renderMessages();
    renderAttachments();
    renderHistory();

    saveChats();

    $("#sidebar")?.classList.remove("open");

    input?.focus();
}

function openChat(id) {
    const c =
        chats.find(x => x.id === id);

    if (!c) return;

    currentId = id;

    messages =
        Array.isArray(c.messages)
            ? c.messages
            : [];

    attachments = [];

    renderMessages();
    renderAttachments();
    renderHistory();

    $("#sidebar")?.classList.remove("open");
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
                m => m.role === "user"
            )?.content ||
            "New chat";

        c.title =
            first
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
                    cache: "no-store"
                }
            );

        if (!r.ok) {
            throw new Error(
                `HTTP ${r.status}`
            );
        }

        const d =
            await r.json();

        modelSelect.innerHTML = "";

        const models =
            Array.isArray(d.models)
                ? d.models
                : [];

        models.forEach(model => {
            const option =
                document.createElement("option");

            option.value = model;
            option.textContent = model;

            modelSelect.appendChild(option);
        });

        const preferred =
            models.find(
                m =>
                    m
                        .toLowerCase()
                        .includes("luna")
            ) ||
            models[0];

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
                    cache: "no-store"
                }
            );

        if (!r.ok) {
            throw new Error();
        }

        const d =
            await r.json();

        const configured =
            Boolean(
                d.api_configured
            );

        if ($("#healthDot")) {
            $("#healthDot").style.background =
                configured
                    ? "#5eead4"
                    : "#ffb86b";
        }

        if ($("#healthText")) {
            $("#healthText").textContent =
                configured
                    ? "Gateway connected"
                    : "API key missing";
        }

    } catch {
        if ($("#healthText")) {
            $("#healthText").textContent =
                "Server unavailable";
        }
    }
}

function setBusy(value) {
    busy = value;

    if (sendBtn) {
        sendBtn.disabled = value;
        sendBtn.textContent =
            value ? "…" : "➤";
    }

    if (input) {
        input.disabled = value;
    }

    const attachBtn =
        $("#attachBtn");

    if (attachBtn) {
        attachBtn.disabled = value;
    }
}

async function uploadFiles(fileList) {
    if (!currentId) return;

    const files =
        [...fileList];

    if (!files.length) return;

    const fd =
        new FormData();

    fd.append(
        "chat_id",
        currentId
    );

    files.forEach(file => {
        fd.append(
            "files",
            file
        );
    });

    try {
        const r =
            await fetch(
                "/api/upload",
                {
                    method: "POST",
                    body: fd
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
        console.error(e);

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
        (file, index) => {
            const el =
                document.createElement("div");

            el.className =
                "attachment";

            el.innerHTML = `
                <span>📎</span>
                <span>
                    ${escapeHtml(file.name)}
                </span>
                <button title="Remove">
                    ×
                </button>
            `;

            el.querySelector(
                "button"
            ).onclick = () => {
                attachments.splice(
                    index,
                    1
                );

                renderAttachments();
            };

            box.appendChild(el);
        }
    );
}

/*
 * Robust SSE parser.
 *
 * Supports:
 * event: token
 * data: {...}
 *
 * Handles:
 * - chunks split in the middle of JSON
 * - CRLF / LF
 * - multiple SSE events in one chunk
 * - final incomplete buffer
 * - UTF-8 streaming
 */
function createSSEParser(onEvent) {
    let buffer = "";

    const decoder =
        new TextDecoder(
            "utf-8"
        );

    function processText(text) {
        buffer += text;

        const events =
            buffer.split(
                /\r?\n\r?\n/
            );

        buffer =
            events.pop() || "";

        for (
            const raw of events
        ) {
            parseEvent(raw);
        }
    }

    function parseEvent(raw) {
        if (!raw.trim()) return;

        let eventName = "message";
        let dataLines = [];

        const lines =
            raw.split(/\r?\n/);

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
            } else if (
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
            return;
        }

        const rawData =
            dataLines.join("\n");

        let data;

        try {
            data =
                JSON.parse(rawData);
        } catch {
            /*
             * Ignore malformed/incomplete
             * SSE payloads rather than
             * killing the entire stream.
             */
            console.warn(
                "Ignored malformed SSE payload:",
                rawData
            );
            return;
        }

        onEvent(
            eventName,
            data
        );
    }

    return {
        push(value) {
            processText(
                decoder.decode(
                    value,
                    {
                        stream: true
                    }
                )
            );
        },

        finish() {
            const remaining =
                decoder.decode();

            if (remaining) {
                processText(
                    remaining
                );
            }

            if (buffer.trim()) {
                parseEvent(buffer);
            }

            buffer = "";
        }
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

    text =
        text.trim();

    const extra =
        attachments.length
            ? `\n\n[Attached files: ${attachments
                .map(x => x.stored)
                .join(", ")}]`
            : "";

    addMessage(
        "user",
        text
    );

    messages.push({
        role: "user",
        content: text + extra
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
    let finished = false;
    let gotToken = false;

    const controller =
        new AbortController();

    activeController =
        controller;

    /*
     * Generous timeout for slow/free
     * model gateways.
     */
    const timeout =
        setTimeout(
            () => {
                try {
                    controller.abort();
                } catch {}
            },
            5 * 60 * 1000
        );

    try {
        const payload = {
            chat_id: currentId,
            model:
                modelSelect.value,
            messages,
            tools_enabled:
                Boolean(
                    $("#toolsToggle")?.checked
                )
        };

        const response =
            await fetch(
                "/api/chat/stream",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",

                        "Accept":
                            "text/event-stream",

                        "Cache-Control":
                            "no-cache"
                    },

                    cache: "no-store",

                    credentials:
                        "same-origin",

                    signal:
                        controller.signal,

                    body:
                        JSON.stringify(
                            payload
                        )
                }
            );

        if (!response.ok) {
            let detail = "";

            try {
                detail =
                    await response.text();
            } catch {}

            throw new Error(
                `Server returned HTTP ${response.status}` +
                (
                    detail
                        ? `: ${detail.slice(0, 700)}`
                        : ""
                )
            );
        }

        /*
         * Normal Railway/FastAPI path.
         */
        if (response.body) {
            const reader =
                response.body
                    .getReader();

            const parser =
                createSSEParser(
                    (event, data) => {

                        if (
                            event ===
                            "token"
                        ) {
                            const token =
                                String(
                                    data?.text ||
                                    ""
                                );

                            if (!token) {
                                return;
                            }

                            gotToken = true;

                            answer +=
                                token;

                            ai.bubble.innerHTML =
                                md(answer) +
                                '<span class="cursor"></span>';

                            chatEl.scrollTop =
                                chatEl.scrollHeight;

                            return;
                        }

                        if (
                            event ===
                            "tool_start"
                        ) {
                            addTool(
                                data?.name ||
                                    "tool",
                                "Running…"
                            );

                            return;
                        }

                        if (
                            event ===
                            "tool_result"
                        ) {
                            addTool(
                                data?.name ||
                                    "tool",
                                data?.result ||
                                    ""
                            );

                            return;
                        }

                        if (
                            event ===
                            "status"
                        ) {
                            if (!answer) {
                                ai.bubble.innerHTML =
                                    `<span class="thinking">${
                                        escapeHtml(
                                            data?.message ||
                                            "Working…"
                                        )
                                    }</span>`;
                            }

                            return;
                        }

                        if (
                            event ===
                            "error"
                        ) {
                            finished = true;

                            throw new Error(
                                data?.message ||
                                "The AI agent returned an error."
                            );
                        }

                        if (
                            event ===
                            "done"
                        ) {
                            finished = true;
                        }
                    }
                );

            while (true) {
                const {
                    value,
                    done
                } =
                    await reader.read();

                if (done) {
                    break;
                }

                if (value) {
                    parser.push(
                        value
                    );
                }
            }

            parser.finish();
        }

        /*
         * The backend completed the
         * request successfully.
         */
        if (!answer && !finished) {
            throw new Error(
                "The AI connection closed before a response was received."
            );
        }

        if (!answer && finished) {
            throw new Error(
                "The AI completed the request but returned no text."
            );
        }

        ai.bubble.innerHTML =
            md(answer);

        if (answer) {
            messages.push({
                role:
                    "assistant",
                content:
                    answer
            });
        }

        updateCurrent();

    } catch (error) {
        console.error(
            "AI stream error:",
            error
        );

        let message =
            error?.message ||
            String(error);

        if (
            error?.name ===
            "AbortError"
        ) {
            message =
                "The AI request timed out or was cancelled. Please try again.";
        }

        /*
         * Preserve any partial answer.
         * Do not replace it with a generic
         * error if useful text already arrived.
         */
        if (
            answer &&
            answer.trim()
        ) {
            ai.bubble.innerHTML =
                md(answer) +
                `<div class="error-text">
                    ${escapeHtml(
                        message
                    )}
                </div>`;

            messages.push({
                role:
                    "assistant",
                content:
                    answer
            });

            updateCurrent();

        } else {
            ai.bubble.innerHTML =
                `<span class="error-text">
                    ${escapeHtml(
                        message
                    )}
                </span>`;

            toast(message);
        }

    } finally {
        clearTimeout(timeout);

        if (
            activeController ===
            controller
        ) {
            activeController =
                null;
        }

        setBusy(false);

        input?.focus();
    }
}

async function downloadChat(
    id = currentId
) {
    const c =
        chats.find(
            x => x.id === id
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
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            chat_id: id,
                            title:
                                c.title,
                            messages:
                                c.messages ||
                                []
                        })
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
                c.title
                    .replace(
                        /[^\w.-]+/g,
                        "_"
                    ) ||
                "AI_Canvas_Chat"
            ) + ".zip";

        document.body.appendChild(a);

        a.click();

        a.remove();

        setTimeout(
            () =>
                URL.revokeObjectURL(
                    url
                ),
            3000
        );

        toast(
            "Workspace download started"
        );

    } catch (e) {
        console.error(e);

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
        .forEach(button => {
            button.onclick = () => {
                input.value =
                    button.dataset.prompt;

                resize();

                input.focus();
            };
        });
}

if ($("#composer")) {
    $("#composer").onsubmit =
        e => {
            e.preventDefault();

            const value =
                input.value;

            input.value = "";

            resize();

            send(value);
        };
}

if (input) {
    input.onkeydown =
        e => {
            if (
                e.key === "Enter" &&
                !e.shiftKey
            ) {
                e.preventDefault();

                $("#composer")
                    ?.requestSubmit();
            }
        };
}

$("#newChat")?.addEventListener(
    "click",
    newChat
);

$("#downloadTop")?.addEventListener(
    "click",
    () => downloadChat()
);

$("#clearBtn")?.addEventListener(
    "click",
    () => {
        if (busy) {
            toast(
                "Please wait for the current response."
            );
            return;
        }

        messages = [];

        updateCurrent();

        renderMessages();

        toast(
            "Current chat cleared"
        );
    }
);

$("#menuBtn")?.addEventListener(
    "click",
    () => {
        $("#sidebar")
            ?.classList.toggle(
                "open"
            );
    }
);

$("#chatSearch")?.addEventListener(
    "input",
    renderHistory
);

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

$("#attachBtn")?.addEventListener(
    "click",
    () => {
        $("#fileInput")?.click();
    }
);

$("#fileInput")?.addEventListener(
    "change",
    e => {
        uploadFiles(
            e.target.files
        );

        /*
         * Allows selecting the same
         * file again later.
         */
        e.target.value = "";
    }
);

document.addEventListener(
    "dragover",
    e => {
        e.preventDefault();
    }
);

document.addEventListener(
    "drop",
    e => {
        e.preventDefault();

        if (
            e.dataTransfer
                ?.files
                ?.length
        ) {
            uploadFiles(
                e.dataTransfer.files
            );
        }
    }
);

/*
 * Initial application boot.
 */
if (!chats.length) {
    newChat();
} else {
    chats.sort(
        (a, b) =>
            b.updated - a.updated
    );

    openChat(
        chats[0].id
    );
}

bindSuggestions();
loadModels();
health();

setInterval(
    health,
    30000
);
